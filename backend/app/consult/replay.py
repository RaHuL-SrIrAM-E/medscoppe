"""Recorded-replay extraction provider. Used only when Gemini credentials are unavailable (or by choice).

It returns a stored model output for a known input. It does NOT extract anything itself, it is always
labelled as a replay in the response, and an unknown input fails loudly instead of guessing.
Fixtures are validated by the same pipeline as live output.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .schema import ExtractRequest, ModelOutput
from .service import ProviderUnavailable


def request_key(utterances) -> str:
    joined = "\n".join(f"{u['speaker'] if isinstance(u, dict) else u.speaker}|{u['text'] if isinstance(u, dict) else u.text}" for u in utterances)
    return hashlib.sha256(joined.encode()).hexdigest()


class ReplayExtractionProvider:
    name = "replay"
    model = "replay-fixture"
    is_replay = True

    def __init__(self, fixture_path: Path) -> None:
        doc = json.loads(Path(fixture_path).read_text(encoding="utf-8"))
        self.provenance: str = doc["provenance"]
        self._entries = {request_key(e["match"]): ModelOutput.model_validate(e["model_output"]) for e in doc["entries"]}

    async def extract(self, request: ExtractRequest) -> ModelOutput:
        found = self._entries.get(request_key(request.utterances))
        if found is None:
            raise ProviderUnavailable(
                "replay_no_match", "No recorded response exists for this input. Provide Gemini credentials or add a fixture.", False
            )
        return found
