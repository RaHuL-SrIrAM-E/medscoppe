"""Regenerate the shared contract files under /contracts. Run after changing the schema or a scenario input.

    .venv/bin/python scripts/export_contracts.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.consult.contract_fixtures import build_all  # noqa: E402

for path, content in build_all().items():
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(content, indent=1, ensure_ascii=False, sort_keys=False) + "\n", encoding="utf-8")
    print("wrote", path.relative_to(Path(__file__).resolve().parents[2]))
