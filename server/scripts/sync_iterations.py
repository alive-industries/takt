"""Snapshot GitHub Projects v2 iterations and item hours to BigQuery."""

import argparse
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.iterations import sync_iterations  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pat", help="Override TAKT_GITHUB_PAT")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO)
    iterations, items = sync_iterations(args.pat, dry_run=args.dry_run)
    print(f"Iterations: {len(iterations)}; iteration items: {len(items)}")
    if args.dry_run:
        print(json.dumps({"iterations": iterations[:3], "iteration_items": items[:3]}, indent=2))


if __name__ == "__main__":
    main()
