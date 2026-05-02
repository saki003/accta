"""accta.ui – interactive MPR viewer (requires the ``ui`` extras).

Install
-------
    pip install "accta[ui]"

Launch
------
    accta-viewer                                   # installed entry-point
    streamlit run accta/ui/app.py                  # direct invocation
    python -c "from accta.ui import run_viewer; run_viewer()"
"""

from __future__ import annotations


def run_viewer(host: str = "localhost", port: int = 8501) -> None:
    """Start the Streamlit MPR viewer.

    Parameters
    ----------
    host:
        Hostname the server binds to.  Use ``"0.0.0.0"`` to expose on LAN.
    port:
        TCP port for the Streamlit server.
    """
    import subprocess
    import sys
    from pathlib import Path

    app_path = Path(__file__).parent / "app.py"
    subprocess.run(
        [
            sys.executable, "-m", "streamlit", "run", str(app_path),
            f"--server.address={host}",
            f"--server.port={port}",
            "--server.headless=true",
        ],
        check=True,
    )
