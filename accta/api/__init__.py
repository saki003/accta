"""accta.api — FastAPI backend for the coronary CTA viewer."""

from __future__ import annotations


def run_server(host: str = "0.0.0.0", port: int = 8000) -> None:
    """Start the uvicorn ASGI server hosting the FastAPI app."""
    import uvicorn

    uvicorn.run(
        "accta.api.main:app",
        host=host,
        port=port,
        reload=False,
        log_level="info",
    )
