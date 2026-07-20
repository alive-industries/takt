import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.exporter import export_pending  # noqa: E402

if __name__ == "__main__":
    print(f"Exported {export_pending()} outbox event(s).")
