from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class PostingPaths:
    data_dir: Path
    pipeline_db: Path
    controller_db: Path


def default_data_dir() -> Path:
    if Path("/.dockerenv").exists() or Path("/app").exists():
        return Path(os.environ.get("DATA_DIR", "/data"))
    return Path(os.environ.get("DATA_DIR", "/opt/alexgetman-posting/data"))


def get_paths() -> PostingPaths:
    data_dir = default_data_dir()
    return PostingPaths(
        data_dir=data_dir,
        pipeline_db=Path(os.environ.get("PIPELINE_DB", str(data_dir / "pipeline.db"))),
        controller_db=Path(os.environ.get("CONTROLLER_DB") or os.environ.get("PIPELINE_DB", str(data_dir / "pipeline.db"))),
    )
