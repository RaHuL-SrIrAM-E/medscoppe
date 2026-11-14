"""Extraction service: provider -> validation -> reconciliation. The provider is replaceable."""
from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Protocol

from .reconcile import reconcile
from .schema import (
    SCHEMA_VERSION,
    ExtractorInfo,
    ExtractorReport,
    ExtractRequest,
    ExtractResponse,
    HeldObservation,
    ModelOutput,
    Rejection,
)
from .validation import Accepted, validate_observation


class ProviderError(Exception):
    """Base class. ``code`` is machine-readable; ``message`` never contains transcript text or secrets."""

    status_code = 500

    def __init__(self, code: str, message: str, retriable: bool) -> None:
        super().__init__(message)
        self.code, self.message, self.retriable = code, message, retriable


class ProviderUnavailable(ProviderError):
    status_code = 503


class ProviderOutputInvalid(ProviderError):
    status_code = 502


class ExtractionProvider(Protocol):
    name: str
    model: str
    is_replay: bool

    async def extract(self, request: ExtractRequest) -> ModelOutput: ...


def default_id_factory(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def default_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class ExtractionService:
    def __init__(
        self,
        provider: ExtractionProvider,
        *,
        id_factory: Callable[[str], str] = default_id_factory,
        now: Callable[[], str] = default_now,
        timer: Callable[[], float] = time.monotonic,
    ) -> None:
        self.provider = provider
        self._id = id_factory
        self._now = now
        self._timer = timer

    async def extract(self, request: ExtractRequest) -> ExtractResponse:
        started = self._timer()
        output = await self.provider.extract(request)  # may raise ProviderError

        utterances = {u.id: u for u in [*request.context_utterances, *request.utterances]}
        new_ids = {u.id for u in request.utterances}

        accepted: list[Accepted] = []
        held: list[HeldObservation] = []
        rejected: list[Rejection] = []
        warnings: list[str] = []
        for proposal in output.proposals:
            # proposal.action_hint and target_id are deliberately ignored: the reconciler decides
            outcome = validate_observation(proposal.observation, utterances, new_ids)
            if outcome.accepted:
                accepted.append(outcome.accepted)
                warnings += [f"{outcome.accepted.symptom or outcome.accepted.label}:{w}" for w in outcome.accepted.warnings]
            elif outcome.held:
                held.append(outcome.held)
            elif outcome.rejection:
                rejected.append(outcome.rejection)

        info = ExtractorInfo(provider=self.provider.name, model=self.provider.model, is_replay=self.provider.is_replay)
        result = reconcile(accepted, request.known_observations, new_id=self._id, now=self._now(), extractor=info)
        rejected += result.rejected
        if self.provider.is_replay:
            warnings.insert(0, "REPLAY_FIXTURE: output is a recorded fixture, not a live model call")

        latency_ms = int((self._timer() - started) * 1000)
        return ExtractResponse(
            extraction_id=self._id("ext"),
            schema_version=SCHEMA_VERSION,  # type: ignore[arg-type]
            proposals=result.proposals,
            held_for_review=held,
            rejected=rejected,
            extractor=ExtractorReport(provider=info.provider, model=info.model, is_replay=info.is_replay, latency_ms=latency_ms),
            warnings=warnings,
        )
