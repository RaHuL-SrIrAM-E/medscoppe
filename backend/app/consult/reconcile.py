"""Decide the real action for each validated observation against what the client already holds.

The model's ``action_hint`` is only a hint. This module compares the new observation with the known
observations of the same symptom and chooses ADD / REINFORCE / REFINE / CONTRADICT itself, so the
store can never receive a silent overwrite. Existing information is never changed here: new
information only fills attributes that were null, and disagreements become explicit conflicts.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .schema import (
    Action,
    Attributes,
    Context,
    ExtractorInfo,
    Observation,
    ObservationKind,
    ObservationRef,
    Proposal,
    QualityPhase,
    Rejection,
    RejectionReason,
    Review,
    Status,
)
from .validation import Accepted, duration_hours

IdFactory = Callable[[str], str]


@dataclass
class Reconciled:
    proposals: list[Proposal]
    rejected: list[Rejection]


def _same_subject(ref: ObservationRef, a: Accepted) -> bool:
    return ref.kind == a.kind and ref.symptom == a.symptom and (ref.label or "").lower() == (a.label or "").lower()


def _durations_agree(x, y) -> bool:
    hx, hy = duration_hours(x), duration_hours(y)
    if hx == hy:
        return True
    tolerance = 0.25 if (x.approximate or y.approximate) else 0.0
    return abs(hx - hy) <= tolerance * max(hx, hy)


def diff_attributes(existing: Attributes, new: Attributes) -> tuple[Attributes | None, bool]:
    """Return (patch with only newly learned fields | None, conflict). Never alters ``existing``."""
    patch = Attributes()
    conflict = False
    if new.onset is not None:
        if existing.onset is None:
            patch.onset = new.onset
        elif existing.onset != new.onset:
            conflict = True
    if new.duration is not None:
        if existing.duration is None:
            patch.duration = new.duration
        elif not _durations_agree(existing.duration, new.duration):
            conflict = True
    if new.severity is not None:
        if existing.severity is None:
            patch.severity = new.severity
        elif existing.severity != new.severity:
            conflict = True
    known_phase = {q.phase: q.character for q in existing.character_over_time}
    for q in new.character_over_time:
        if q.phase not in known_phase:
            patch.character_over_time.append(QualityPhase(phase=q.phase, character=q.character))
        elif known_phase[q.phase] != q.character:
            conflict = True
    for c in new.context:
        if c not in existing.context:
            patch.context.append(Context(c))
    return (patch if patch != Attributes() else None), conflict


def reconcile(
    accepted: list[Accepted],
    known: list[ObservationRef],
    *,
    new_id: IdFactory,
    now: str,
    extractor: ExtractorInfo,
) -> Reconciled:
    working = [r.model_copy(deep=True) for r in known]
    proposals: list[Proposal] = []
    rejected: list[Rejection] = []

    def build(a: Accepted, conflicts_with: list[str]) -> Observation:
        return Observation(
            id=new_id("obs"), kind=a.kind, symptom=a.symptom, label=a.label, status=a.status, source=a.source,
            originated_as=a.source, confidence=a.confidence, attributes=a.attributes, evidence=a.evidence,
            revision=1, conflicts_with=conflicts_with, review=Review(), extractor=extractor, created_at=now,
        )

    def track(o: Observation) -> None:
        working.append(
            ObservationRef(id=o.id, kind=o.kind, symptom=o.symptom, label=o.label, status=o.status, source=o.source,
                           revision=1, attributes=o.attributes)
        )

    for a in accepted:
        same = [r for r in working if _same_subject(r, a)]
        if not same:
            o = build(a, [])
            proposals.append(Proposal(action=Action.ADD, observation=o))
            track(o)
            continue

        unresolved = [r for r in same if r.status == Status.UNRESOLVED]
        definite = [r for r in same if r.status in (Status.PRESENT, Status.ABSENT)]
        unknown = [r for r in same if r.status == Status.UNKNOWN]
        if a.status == Status.UNKNOWN:
            rejected.append(Rejection(reason_code=RejectionReason.NO_NEW_INFORMATION, symptom=a.symptom))
            continue
        if unresolved and not definite:
            # an open conflict already exists: record the new statement alongside it, for the doctor to resolve
            o = build(a, [r.id for r in unresolved][:8])
            proposals.append(Proposal(action=Action.ADD, observation=o))
            track(o)
            continue
        if not definite and unknown:
            # A definite statement after UNKNOWN revises the active observation instead of creating a duplicate.
            # History is kept: the client appends a revision. Observations from different sources are never merged.
            t = next((r for r in reversed(unknown) if r.source == a.source), None)
            if t is None:
                o = build(a, [])
                proposals.append(Proposal(action=Action.ADD, observation=o))
                track(o)
                continue
            patch, _ = diff_attributes(t.attributes, a.attributes)
            proposals.append(Proposal(action=Action.REVISE, target_id=t.id, new_status=a.status, attributes_patch=patch, added_evidence=a.evidence))
            t.status = a.status
            t.revision += 1
            if patch is not None:
                t.attributes = _merge(t.attributes, patch)
            continue
        target = (definite or same)[-1]

        if target.status != a.status and target.status in (Status.PRESENT, Status.ABSENT) and a.status in (Status.PRESENT, Status.ABSENT):
            # directly opposed statements: both stay, both become UNRESOLVED until the doctor decides
            o = build(a, [target.id])
            proposals.append(Proposal(action=Action.CONTRADICT, target_id=target.id, observation=o))
            target.status = Status.UNRESOLVED
            track(o)
            continue
        if target.status != a.status:
            o = build(a, [])
            proposals.append(Proposal(action=Action.ADD, observation=o))
            track(o)
            continue

        patch, conflict = diff_attributes(target.attributes, a.attributes)
        if conflict:
            o = build(a, [target.id])
            proposals.append(Proposal(action=Action.CONTRADICT, target_id=target.id, observation=o))
            target.status = Status.UNRESOLVED
            track(o)
        elif patch is not None:
            proposals.append(Proposal(action=Action.REFINE, target_id=target.id, attributes_patch=patch, added_evidence=a.evidence))
            target.revision += 1
            target.attributes = _merge(target.attributes, patch)
        else:
            proposals.append(Proposal(action=Action.REINFORCE, target_id=target.id, added_evidence=a.evidence))
            target.revision += 1
    return Reconciled(proposals=proposals, rejected=rejected)


def _merge(existing: Attributes, patch: Attributes) -> Attributes:
    out = existing.model_copy(deep=True)
    out.onset = out.onset or patch.onset
    out.duration = out.duration or patch.duration
    out.severity = out.severity or patch.severity
    out.character_over_time = [*out.character_over_time, *patch.character_over_time]
    out.context = [*out.context, *[c for c in patch.context if c not in out.context]]
    return out
