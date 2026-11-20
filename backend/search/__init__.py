"""Local SQLite FTS5 search package for AvaNevis meeting history."""

from .history_index import (
    INDEX_SCHEMA_VERSION,
    build_fts5_query,
    extract_query_tokens,
    get_history_index_status,
    rebuild_history_index,
    search_history_index,
    snippet_text_to_parts,
    sync_history_index,
)

__all__ = [
    "INDEX_SCHEMA_VERSION",
    "build_fts5_query",
    "extract_query_tokens",
    "get_history_index_status",
    "rebuild_history_index",
    "search_history_index",
    "snippet_text_to_parts",
    "sync_history_index",
]
