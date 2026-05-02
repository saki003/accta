"""Application-wide configuration.

Workspace location resolution (highest priority first):
  1. ACCTA_DATA_DIR environment variable
  2. ~/.config/accta/config.json -> "data_dir"
  3. ~/.accta/data (default)
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_DATA_DIR = Path.home() / "Documents" / "accta" / "studies"
CONFIG_PATH = Path.home() / ".config" / "accta" / "config.json"


def _resolve_data_dir() -> Path:
    env = os.environ.get("ACCTA_DATA_DIR")
    if env:
        return Path(env)
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text())
            if cfg.get("data_dir"):
                return Path(cfg["data_dir"])
        except Exception:
            pass
    return DEFAULT_DATA_DIR


# Resolved at import time.  Changing the workspace at runtime requires a
# backend restart so all module-level imports of DATA_DIR pick it up.
DATA_DIR: Path = _resolve_data_dir()


def configured_via() -> str:
    if os.environ.get("ACCTA_DATA_DIR"):
        return "env"
    if CONFIG_PATH.exists():
        try:
            if json.loads(CONFIG_PATH.read_text()).get("data_dir"):
                return "config-file"
        except Exception:
            pass
    return "default"


def write_config(data_dir: str) -> None:
    """Persist a new workspace path to the user config file. Requires restart to apply."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    existing: dict = {}
    if CONFIG_PATH.exists():
        try:
            existing = json.loads(CONFIG_PATH.read_text())
        except Exception:
            existing = {}
    existing["data_dir"] = str(Path(data_dir).expanduser().resolve())
    CONFIG_PATH.write_text(json.dumps(existing, indent=2))


def study_dir(uid: str) -> Path:
    """Return (and create) the per-study data directory."""
    d = DATA_DIR / uid
    d.mkdir(parents=True, exist_ok=True)
    return d


def pipeline_dir(uid: str) -> Path:
    """Return (and create) the pipeline cache sub-directory for a study."""
    d = study_dir(uid) / "pipeline"
    d.mkdir(parents=True, exist_ok=True)
    return d
