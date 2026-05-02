"""FastAPI application entry-point for the accta coronary CTA viewer."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from accta.api.routers import algorithms, browse, config as config_router, mpr, slices, studies, volumes

logger = logging.getLogger(__name__)

app = FastAPI(
    title="accta Coronary CTA Viewer API",
    version="0.1.0",
    description="REST backend for the clinical coronary CTA viewer.",
)

# ---------------------------------------------------------------------------
# CORS – allow the Vite dev server and a local preview port
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
app.include_router(studies.router)
app.include_router(slices.router)
app.include_router(algorithms.router)
app.include_router(mpr.router)
app.include_router(browse.router)
app.include_router(volumes.router)
app.include_router(config_router.router)


# ---------------------------------------------------------------------------
# Startup: re-register persisted studies so they appear in the worklist
# without the user having to re-Browse after every backend restart.
# Source DICOMs stay where they are; we just reload the pixel data on demand.
# ---------------------------------------------------------------------------
@app.on_event("startup")
async def _restore_persisted_studies() -> None:
    import SimpleITK as sitk
    import numpy as np
    from accta.api.session import store
    from accta.pipeline.cache import (
        list_persisted_study_uids, load_study_meta,
        load_preprocess, load_vesselness, load_cost,
    )

    uids = list_persisted_study_uids()
    if not uids:
        return
    logger.info("startup: re-registering %d persisted studies", len(uids))
    for uid in uids:
        meta = load_study_meta(uid)
        if not meta or not meta.get("file_names"):
            continue
        file_names = [str(p) for p in meta["file_names"]]
        if not all(Path(f).exists() for f in file_names):
            logger.warning("startup: source DICOMs missing for %s — skipping", uid)
            continue
        try:
            reader = sitk.ImageSeriesReader()
            reader.SetFileNames(file_names)
            img = reader.Execute()
            arr = sitk.GetArrayFromImage(img).astype(np.float32)
            spacing_raw = img.GetSpacing()
            origin_raw = img.GetOrigin()
            spacing = (float(spacing_raw[2]), float(spacing_raw[1]), float(spacing_raw[0]))
            origin = (float(origin_raw[2]), float(origin_raw[1]), float(origin_raw[0]))
            store.add(uid, arr, spacing, origin, img.GetDirection(), meta.get("name", uid))
        except Exception as exc:
            logger.warning("startup: failed to reload %s: %s", uid, exc)
            continue

        # Eagerly restore cached pipeline derivatives so the worklist + viewer
        # can serve overlays immediately without forcing the user to "Rerun".
        name = meta.get("name", uid)
        try:
            pre = load_preprocess(uid)
            if pre is not None:
                pre_uid = f"preprocess_{uid}"
                store.add(pre_uid, pre["arr"], pre["spacing"], pre["origin"],
                          pre["direction"], name=f"preprocess({name})")
                pre_entry = store.get(pre_uid)
                if pre_entry is not None:
                    with store._lock:
                        pre_entry["cardiac_roi"]          = pre["cardiac_roi"]
                        pre_entry["central_blood_pool"]   = pre["central_blood_pool"]
                        pre_entry["blood_pool_hu_median"] = pre.get("blood_pool_hu_median", 300.0)
                logger.info("startup: restored preprocess for %s", uid)
        except Exception as exc:
            logger.warning("startup: failed to restore preprocess for %s: %s", uid, exc)

        try:
            ves = load_vesselness(uid)
            if ves is not None:
                store.add(f"vesselness_{uid}", ves["arr"], ves["spacing"], ves["origin"],
                          ves["direction"], name=f"vesselness({name})")
                logger.info("startup: restored vesselness for %s", uid)
        except Exception as exc:
            logger.warning("startup: failed to restore vesselness for %s: %s", uid, exc)

        try:
            cst = load_cost(uid)
            if cst is not None:
                store.add(f"cost_{uid}", cst["arr"], cst["spacing"], cst["origin"],
                          cst["direction"], name=f"cost({name})")
                logger.info("startup: restored cost image for %s", uid)
        except Exception as exc:
            logger.warning("startup: failed to restore cost for %s: %s", uid, exc)


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
@app.get("/health", tags=["health"])
async def health() -> JSONResponse:
    """Simple liveness probe."""
    return JSONResponse({"status": "ok"})


# ---------------------------------------------------------------------------
# Serve the compiled frontend (optional – only when the build exists)
# ---------------------------------------------------------------------------
_FRONTEND_BUILD = Path(__file__).parent.parent.parent / "frontend" / "dist"

if _FRONTEND_BUILD.is_dir():
    # Mount static assets (js/css/etc.) under /assets
    _assets = _FRONTEND_BUILD / "assets"
    if _assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(_assets)), name="frontend-assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_frontend(full_path: str) -> FileResponse:  # noqa: ARG001
        """Fall-through handler that serves the SPA index for any unknown path."""
        index = _FRONTEND_BUILD / "index.html"
        return FileResponse(str(index))
else:
    logger.info(
        "Frontend build not found at %s — static serving disabled.",
        _FRONTEND_BUILD,
    )
