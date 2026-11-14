"""Deterministic generation of the shared contract fixtures under /contracts.

The committed ``*.response.json`` files are produced by running the REAL service (validation and reconciliation)
over the scenario inputs with fixed ids, clock and timer. Backend tests regenerate them and fail on any drift;
frontend tests consume them, so both sides are checked against the same golden outputs.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from .replay import ReplayExtractionProvider
from .reconcile import _merge as merge_attributes
from .schema import Attributes, ExtractRequest, ModelOutput, ObservationRef, Status, schema_bundle
from .service import ExtractionService

REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = REPO_ROOT / "contracts"
FIXED_NOW = "2026-11-15T09:00:00Z"


class StaticProvider:
    """Returns a fixed model output. Test and fixture use only; never selected by configuration."""

    name = "fixture"
    model = "static"
    is_replay = False

    def __init__(self, output: ModelOutput) -> None:
        self._output = output

    async def extract(self, request: ExtractRequest) -> ModelOutput:
        return self._output


def deterministic_service(provider, tag: str = "") -> ExtractionService:
    """``tag`` makes ids unique per scenario (production ids are random), so several fixture responses can be
    applied to one store without looking like duplicates."""
    counters: dict[str, int] = {}

    def new_id(prefix: str) -> str:
        counters[prefix] = counters.get(prefix, 0) + 1
        return f"{prefix}_{tag}_{counters[prefix]:03d}" if tag else f"{prefix}_{counters[prefix]:03d}"

    return ExtractionService(provider, id_factory=new_id, now=lambda: FIXED_NOW, timer=lambda: 0.0)


def _dump(model) -> Any:
    return json.loads(model.model_dump_json())


def run_scenario(path: Path) -> dict[str, Any]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    request = ExtractRequest.model_validate(doc["request"])
    service = deterministic_service(StaticProvider(ModelOutput.model_validate(doc["model_output"])), tag=path.stem)
    return _dump(asyncio.run(service.extract(request)))


def refs_after(known: list[ObservationRef], response: dict[str, Any]) -> list[ObservationRef]:
    """What a client would send as ``known_observations`` after applying a response (mirrors the frontend store)."""
    refs = {r.id: r.model_copy(deep=True) for r in known}
    for p in response["proposals"]:
        t = refs.get(p.get("target_id") or "")
        if p["action"] in ("ADD", "CONTRADICT"):
            o = p["observation"]
            refs[o["id"]] = ObservationRef(
                id=o["id"], kind=o["kind"], symptom=o["symptom"], label=o["label"], status=o["status"],
                source=o["source"], revision=1, attributes=o["attributes"],
            )
            if p["action"] == "CONTRADICT" and t:
                t.status = Status.UNRESOLVED
        elif t:
            t.revision += 1
            if p["action"] == "REVISE":
                t.status = Status(p["new_status"])
            if p["action"] in ("REFINE", "REVISE") and p["attributes_patch"]:
                t.attributes = merge_attributes(t.attributes, Attributes.model_validate(p["attributes_patch"]))
    return list(refs.values())


def run_synthetic_chain() -> list[dict[str, Any]]:
    """The primary demo: three batches through the real service using the labelled replay fixture."""
    base = CONTRACTS / "fixtures" / "synthetic-respiratory"
    transcript = json.loads((base / "transcript.json").read_text(encoding="utf-8"))
    service = deterministic_service(ReplayExtractionProvider(base / "replay.json"), tag="syn")
    seen: list[dict[str, Any]] = []
    known: list[ObservationRef] = []
    out: list[dict[str, Any]] = []
    for batch in transcript["batches"]:
        request = ExtractRequest.model_validate(
            {
                "schema_version": "1.0",
                "consultation_id": transcript["consultation_id"],
                "data_classification": "SYNTHETIC",
                "utterances": batch["utterances"],
                "context_utterances": seen[-6:],
                "known_observations": [_dump(r) for r in known],
            }
        )
        response = _dump(asyncio.run(service.extract(request)))
        out.append(response)
        known = refs_after(known, response)
        seen += batch["utterances"]
    return out


def build_all() -> dict[Path, Any]:
    files: dict[Path, Any] = {CONTRACTS / "schema" / "consultation.schema.json": schema_bundle()}
    for path in sorted((CONTRACTS / "fixtures" / "scenarios").glob("*.json")):
        if path.name.endswith(".response.json"):
            continue
        files[path.with_name(path.stem + ".response.json")] = run_scenario(path)
    for i, response in enumerate(run_synthetic_chain(), start=1):
        files[CONTRACTS / "fixtures" / "synthetic-respiratory" / f"response-{i}.json"] = response
    return files
