"""Router: /config — workspace location and other user-facing app settings."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from accta.api.config import DATA_DIR, DEFAULT_DATA_DIR, configured_via, write_config

router = APIRouter(prefix="/config", tags=["config"])


class WorkspaceInfo(BaseModel):
    data_dir: str
    default_data_dir: str
    configured_via: str  # "env" | "config-file" | "default"


class WorkspaceUpdate(BaseModel):
    data_dir: str


@router.get("/workspace", response_model=WorkspaceInfo)
async def get_workspace() -> WorkspaceInfo:
    return WorkspaceInfo(
        data_dir=str(DATA_DIR),
        default_data_dir=str(DEFAULT_DATA_DIR),
        configured_via=configured_via(),
    )


@router.put("/workspace")
async def set_workspace(req: WorkspaceUpdate) -> dict:
    """Save a new workspace path to the user config file.

    Returns ``restart_required: true`` — the backend must be restarted for the
    change to take effect (module-level DATA_DIR captures resolve at import time).
    """
    new_path = Path(req.data_dir).expanduser()
    if not new_path.parent.exists():
        raise HTTPException(
            status_code=400,
            detail=f"Parent directory does not exist: {new_path.parent}",
        )
    try:
        new_path.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot create directory: {exc}") from exc
    if not new_path.is_dir():
        raise HTTPException(status_code=400, detail="Path exists but is not a directory.")

    write_config(str(new_path.resolve()))
    return {
        "data_dir": str(new_path.resolve()),
        "restart_required": True,
    }
