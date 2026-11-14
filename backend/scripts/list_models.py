"""List the Gemini models the configured key can use, so GEMINI_MODEL can be chosen from the account.

    GEMINI_API_KEY=... .venv/bin/python scripts/list_models.py

Never prints the key. Requires network access and a key; it does nothing without one.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402

settings = get_settings()
if not settings.gemini_api_key:
    sys.exit("GEMINI_API_KEY is not set (environment or backend/.env). Nothing to list.")

from google import genai  # noqa: E402

client = genai.Client(api_key=settings.gemini_api_key)
rows = []
for m in client.models.list():
    actions = list(getattr(m, "supported_actions", None) or [])
    rows.append((m.name, actions))
for name, actions in sorted(rows):
    mark = "*" if "generateContent" in actions else " "
    print(f"{mark} {name}   {','.join(actions)}")
print("\n* = supports generateContent (what the extraction adapter uses). Set GEMINI_MODEL to the model id (the part after 'models/').")
