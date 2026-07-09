"""Summary sidecar path helpers and atomic JSON/Markdown writers."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

from .summary_pipeline import render_summary_markdown, validate_summary_json


def sidecar_paths(transcript_path: str) -> Dict[str, str]:
    source = Path(transcript_path)
    base = source.with_suffix("")
    return {
        "jsonPath": str(base.with_suffix(".summary.json")),
        "markdownPath": str(base.with_suffix(".summary.md")),
    }


def save_summary_outputs(
    *,
    summary: Dict[str, Any],
    metadata: Dict[str, Any],
    json_path: str,
    markdown_path: str,
) -> Dict[str, str]:
    json_target = Path(json_path)
    markdown_target = Path(markdown_path)
    json_target.parent.mkdir(parents=True, exist_ok=True)
    markdown_target.parent.mkdir(parents=True, exist_ok=True)

    json_payload = {"summary": validate_summary_json(summary), "metadata": dict(metadata)}
    temp_suffix = f".{os.getpid()}.{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}.tmp"
    temp_json = json_target.with_name(f".{json_target.name}{temp_suffix}")
    temp_markdown = markdown_target.with_name(f".{markdown_target.name}{temp_suffix}")
    backup_json = json_target.with_name(f".{json_target.name}.bak")
    backup_markdown = markdown_target.with_name(f".{markdown_target.name}.bak")
    had_json = json_target.exists()
    had_markdown = markdown_target.exists()
    try:
        temp_json.write_text(json.dumps(json_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp_markdown.write_text(render_summary_markdown(summary, metadata), encoding="utf-8")
        if had_json:
            json_target.replace(backup_json)
        if had_markdown:
            markdown_target.replace(backup_markdown)
        temp_json.replace(json_target)
        try:
            temp_markdown.replace(markdown_target)
        except Exception:
            if json_target.exists():
                json_target.unlink()
            if had_json and backup_json.exists():
                backup_json.replace(json_target)
            raise
        for backup_path in (backup_json, backup_markdown):
            if backup_path.exists():
                backup_path.unlink()
    finally:
        for temp_path in (temp_json, temp_markdown):
            if temp_path.exists():
                temp_path.unlink()
        if backup_json.exists() and not json_target.exists():
            backup_json.replace(json_target)
        elif backup_json.exists():
            backup_json.unlink()
        if backup_markdown.exists() and not markdown_target.exists():
            backup_markdown.replace(markdown_target)
        elif backup_markdown.exists():
            backup_markdown.unlink()
    return {"jsonPath": str(json_target), "markdownPath": str(markdown_target)}
