"""CLI entrypoint for AvaNevis SQLite FTS5 History search."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .history_index import (
    get_history_index_status,
    rebuild_history_index,
    search_history_index,
    sync_history_index,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="AvaNevis local SQLite FTS5 history index CLI")
    parser.add_argument("--recordings-dir", required=True, help="Path to userData recordings directory")
    parser.add_argument("--index-path", required=True, help="Path to history-index.sqlite")

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("sync", help="Incrementally sync index from recordings_dir")
    subparsers.add_parser("rebuild", help="Atomically rebuild index from scratch")
    subparsers.add_parser("status", help="Inspect index status")

    search_parser = subparsers.add_parser("search", help="Search indexed meetings and passages")
    search_parser.add_argument("--query", default=None, help="Search query text")
    search_parser.add_argument("--stdin-json", action="store_true", help="Read search options from stdin")
    search_parser.add_argument("--limit", type=int, default=50, help="Max matched meetings")
    search_parser.add_argument("--max-matches", type=int, default=3, help="Max passages per meeting")
    search_parser.add_argument("--meeting-id", default=None, help="Optional single meeting ID scope")
    search_parser.add_argument("--date-from", default=None, help="Optional inclusive start ISO date")
    search_parser.add_argument("--date-to", default=None, help="Optional inclusive end ISO date")
    search_parser.add_argument("--tags", default=None, help="Optional comma-separated recording tag filter")
    search_parser.add_argument("--no-sync", action="store_true", help="Skip incremental sync before query")

    args = parser.parse_args()
    recordings_dir = Path(args.recordings_dir)
    index_path = Path(args.index_path)

    if args.command == "sync":
        result = sync_history_index(recordings_dir, index_path)
    elif args.command == "rebuild":
        result = rebuild_history_index(recordings_dir, index_path)
    elif args.command == "status":
        result = get_history_index_status(recordings_dir, index_path)
    elif args.command == "search":
        tags = args.tags.split(",") if args.tags is not None else None
        if args.stdin_json:
            options = json.load(sys.stdin)
            args.query = options.get("query", "")
            if "tags" in options:
                tags = options["tags"]
                if tags is None:
                    raise ValueError("Invalid recording tags in scope filter.")
                if isinstance(tags, str):
                    tags = tags.split(",")
        if args.query is None:
            parser.error("search requires --query or --stdin-json")
        result = search_history_index(
            recordings_dir,
            index_path,
            query=args.query,
            limit=args.limit,
            max_matches_per_meeting=args.max_matches,
            meeting_id=args.meeting_id,
            date_from=args.date_from,
            date_to=args.date_to,
            tags=tags,
            sync=not args.no_sync,
        )
    else:
        parser.print_help(sys.stderr)
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
