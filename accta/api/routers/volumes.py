"""Router: /volumes — whole-volume download as NIfTI-1 (.nii.gz).

The browser fetches the entire float32 volume in one request, decompresses it
with the built-in DecompressionStream API, and uploads it to a WebGL
Data3DTexture — eliminating the per-slice HTTP round-trip overhead.

NIfTI-1 header layout (348 bytes):
  https://nifti.nimh.nih.gov/pub/dist/src/niftilib/nifti1.h
We write only the fields the browser parser needs; everything else is 0.
"""

from __future__ import annotations

import gzip
import io
import struct

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from accta.api.session import store

router = APIRouter(prefix="/volumes", tags=["volumes"])

# ---------------------------------------------------------------------------
# NIfTI-1 header builder
# ---------------------------------------------------------------------------

def _nifti1_header(
    shape: tuple[int, int, int],        # (nz, ny, nx)  — C/array order
    spacing: tuple[float, float, float], # (dz, dy, dx) mm
    origin: tuple[float, float, float],  # (oz, oy, ox) mm
    direction: tuple[float, ...],        # 9-element row-major direction cosines
) -> bytes:
    """Build a minimal NIfTI-1 header (348 bytes).

    We use qform_code=1 (scanner coordinates) and encode the affine as a
    quaternion + pixdim + qoffset.  For axis-aligned and common oblique
    volumes SimpleITK guarantees orthonormal direction cosines so the
    quaternion conversion is always valid.

    Array convention: arr[z, y, x]  →  NIfTI dim[1]=nx, dim[2]=ny, dim[3]=nz.
    """
    nz, ny, nx = shape
    dz, dy, dx = spacing
    oz, oy, ox = origin

    # Direction matrix: SimpleITK stores row-major (each row is a cosine).
    # d[0:3]  = cosines of X-axis (fastest-varying) in (x,y,z) world space
    # d[3:6]  = cosines of Y-axis
    # d[6:9]  = cosines of Z-axis
    d = direction  # 9 elements

    # Build the full affine in NIfTI convention (world = R * vox + T):
    #   X_world = d[0]*dx*i + d[3]*dy*j + d[6]*dz*k + ox_world
    # where i=column index (X), j=row index (Y), k=slice index (Z) in NIfTI
    # but our array is (Z,Y,X) so NIfTI i=arr_x, j=arr_y, k=arr_z.
    #
    # Affine (3×4) = [[d[0]*dx, d[3]*dy, d[6]*dz, ox_world],
    #                  [d[1]*dx, d[4]*dy, d[7]*dz, oy_world],
    #                  [d[2]*dx, d[5]*dy, d[8]*dz, oz_world]]
    #
    # SimpleITK origin/spacing are in (x,y,z) world mm; our store converts
    # to (oz,oy,ox) = (world_z, world_y, world_x).  We reconstruct world
    # (x,y,z) origin for the NIfTI header.
    ox_w, oy_w, oz_w = ox, oy, oz  # world x,y,z mm

    R = np.array([
        [d[0]*dx, d[3]*dy, d[6]*dz],
        [d[1]*dx, d[4]*dy, d[7]*dz],
        [d[2]*dx, d[5]*dy, d[8]*dz],
    ], dtype=np.float64)

    # Convert rotation matrix to quaternion (b,c,d; a is always ≥ 0 in NIfTI)
    # Algorithm: Shepperd's method
    tr = R[0,0] + R[1,1] + R[2,2]
    if tr > 0:
        s = 0.5 / np.sqrt(tr + 1.0)
        qa = 0.25 / s
        qb = (R[2,1] - R[1,2]) * s
        qc = (R[0,2] - R[2,0]) * s
        qd = (R[1,0] - R[0,1]) * s
    elif R[0,0] > R[1,1] and R[0,0] > R[2,2]:
        s = 2.0 * np.sqrt(1.0 + R[0,0] - R[1,1] - R[2,2])
        qa = (R[2,1] - R[1,2]) / s
        qb = 0.25 * s
        qc = (R[0,1] + R[1,0]) / s
        qd = (R[0,2] + R[2,0]) / s
    elif R[1,1] > R[2,2]:
        s = 2.0 * np.sqrt(1.0 + R[1,1] - R[0,0] - R[2,2])
        qa = (R[0,2] - R[2,0]) / s
        qb = (R[0,1] + R[1,0]) / s
        qc = 0.25 * s
        qd = (R[1,2] + R[2,1]) / s
    else:
        s = 2.0 * np.sqrt(1.0 + R[2,2] - R[0,0] - R[1,1])
        qa = (R[1,0] - R[0,1]) / s
        qb = (R[0,2] + R[2,0]) / s
        qc = (R[1,2] + R[2,1]) / s
        qd = 0.25 * s

    if qa < 0:
        qb, qc, qd = -qb, -qc, -qd

    # Determine qfac: +1 if right-handed, -1 if left-handed
    qfac = 1.0 if np.linalg.det(R) >= 0 else -1.0

    # ---------------------------------------------------------------------------
    # Pack the 348-byte header (all little-endian)
    # NIfTI-1 struct (partial — only fields we fill):
    #   4   sizeof_hdr   = 348
    #  36   data_type    (unused, 10 bytes)
    #   ...
    # See: https://nifti.nimh.nih.gov/pub/dist/src/niftilib/nifti1.h
    # We build the full 348 bytes with struct.pack using fixed offsets.
    # ---------------------------------------------------------------------------
    hdr = bytearray(348)

    def put_i32(offset: int, val: int) -> None:
        struct.pack_into("<i", hdr, offset, val)

    def put_i16(offset: int, val: int) -> None:
        struct.pack_into("<h", hdr, offset, val)

    def put_f32(offset: int, val: float) -> None:
        struct.pack_into("<f", hdr, offset, float(val))

    def put_u8(offset: int, val: int) -> None:
        hdr[offset] = val & 0xFF

    # sizeof_hdr = 348
    put_i32(0, 348)

    # dim[0]=3, dim[1]=nx, dim[2]=ny, dim[3]=nz
    put_i16(40, 3)   # dim[0] — number of dimensions
    put_i16(42, nx)  # dim[1] — x (fastest)
    put_i16(44, ny)  # dim[2] — y
    put_i16(46, nz)  # dim[3] — z (slowest)

    # datatype = 16 (FLOAT32), bitpix = 32
    put_i16(70, 16)
    put_i16(72, 32)

    # pixdim[0]=qfac, pixdim[1]=dx, pixdim[2]=dy, pixdim[3]=dz
    put_f32(76, qfac)
    put_f32(80, float(dx))
    put_f32(84, float(dy))
    put_f32(88, float(dz))

    # vox_offset = 352 (348 header + 4 extension bytes)
    put_f32(108, 352.0)

    # scl_slope=1, scl_inter=0 (pixel values are already HU)
    put_f32(112, 1.0)
    put_f32(116, 0.0)

    # xyzt_units = 2 (mm)
    put_u8(123, 2)

    # qform_code = 1 (scanner coords)
    put_i16(252, 1)
    # sform_code = 0

    # quatern_b, quatern_c, quatern_d
    put_f32(256, float(qb))
    put_f32(260, float(qc))
    put_f32(264, float(qd))

    # qoffset_x, qoffset_y, qoffset_z  (world-mm origin)
    put_f32(268, float(ox_w))
    put_f32(272, float(oy_w))
    put_f32(276, float(oz_w))

    # magic = "n+1\0" (single-file NIfTI)
    hdr[344:348] = b"n+1\0"

    return bytes(hdr)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.get("/{uid}/nifti")
async def get_volume_nifti(uid: str) -> Response:
    """Return the full float32 volume as a gzip-compressed NIfTI-1 file.

    The browser fetches this once, decompresses it (DecompressionStream),
    parses the 348-byte header, and uploads the voxel data to a WebGL
    Data3DTexture for instant MPR slicing at any orientation.
    """
    entry = store.get(uid)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Study '{uid}' not found.")

    ok = store.wait_ready(uid, timeout=60.0)
    if not ok:
        raise HTTPException(status_code=503, detail="Study is still loading.")

    arr: np.ndarray = entry["arr"]          # float32, shape (nz, ny, nx)
    spacing: tuple = entry["spacing"]       # (dz, dy, dx) mm
    origin: tuple = entry["origin"]         # (oz, oy, ox) mm
    direction: tuple = entry["direction"]   # 9-element

    hdr = _nifti1_header(arr.shape, spacing, origin, direction)

    # NIfTI extension block (4 bytes of zeros = no extensions)
    ext = b"\x00\x00\x00\x00"

    # Voxel data: NIfTI stores x-fastest, which matches numpy C-order for
    # arr[z, y, x] → x varies fastest in memory.
    voxels = arr.tobytes()  # already C-order float32

    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=1) as gz:
        gz.write(hdr)
        gz.write(ext)
        gz.write(voxels)

    return Response(
        content=buf.getvalue(),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{uid}.nii.gz"',
            "Cache-Control": "private, max-age=300",
        },
    )
