"""Deterministic validation of model output. Nothing here trusts the model.

Each model observation is checked independently and ends in exactly one of:
accepted (possibly with sanitised attributes), held for speaker review, or rejected with a reason code.
Rejection reasons are codes only; transcript text is never logged or echoed in errors.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .schema import (
    LABEL_PATTERN,
    Attributes,
    Confidence,
    Duration,
    DurationUnit,
    Evidence,
    EvidenceRole,
    HeldObservation,
    ModelObservation,
    ObservationKind,
    Rejection,
    RejectionReason,
    Source,
    Speaker,
    Status,
    SymptomCode,
    Utterance,
)

# ----------------------------------------------------------------------------- dose / prescription text
_DOSE_PATTERNS = [
    re.compile(r"\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|ug|ml|iu|units?|tabs?|tablets?|pills?|capsules?|puffs?)\b", re.I),
    # a quantity written in words: "two tablets", "half a pill", "a couple of puffs"
    re.compile(
        r"\b(?:one|two|three|four|five|six|seven|eight|ten|a|an|half|couple of)\s+(?:a\s+)?"
        r"(?:tablets?|pills?|capsules?|puffs?|drops|teaspoons?|tablespoons?|sachets?|inhalers?)\b",
        re.I,
    ),
    re.compile(r"\b(?:dose|doses|dosage|dosing|prescri\w*|posology)\b", re.I),
]


def contains_dose_text(s: str | None) -> bool:
    """True for anything that looks like a medication dose or prescription. Such text is never stored."""
    return bool(s) and any(p.search(s) for p in _DOSE_PATTERNS)  # type: ignore[arg-type]


# ----------------------------------------------------------------------------- verbatim evidence
def _normalise_quotes(s: str) -> str:
    # one-to-one character replacement, so offsets computed on the result are valid for the original
    return s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')


def locate_quote(text: str, quote: str) -> tuple[int, int] | None:
    """Find ``quote`` in ``text`` allowing only case and whitespace differences.

    Returns offsets into the ORIGINAL text, so the stored quote can be re-cut from the source and is
    verbatim by construction. Anything else (reworded, summarised, invented) returns None.
    """
    t, q = _normalise_quotes(text), _normalise_quotes(quote).strip()
    if len(re.findall(r"\w", q)) < 2:
        return None
    i = t.find(q)
    if i >= 0:
        return i, i + len(q)
    tokens = re.findall(r"\w+|[^\w\s]", q)
    if not tokens:
        return None
    parts: list[str] = []
    for prev, tok in zip([None, *tokens], tokens):
        if prev is not None:
            both_words = re.match(r"\w", prev) and re.match(r"\w", tok)
            parts.append(r"\s+" if both_words else r"\s*")
        parts.append(re.escape(tok))
    m = re.search("".join(parts), t, flags=re.IGNORECASE)
    return (m.start(), m.end()) if m else None


# ----------------------------------------------------------------------------- durations
_WORD_NUMBERS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fourteen": 14, "twenty": 20, "thirty": 30,
    "couple": 2,
}
_UNIT_WORDS = {"hour": DurationUnit.HOURS, "day": DurationUnit.DAYS, "week": DurationUnit.WEEKS, "month": DurationUnit.MONTHS}
_DURATION_RE = re.compile(r"\b(\d{1,3}|[a-z]+)\s+(?:of\s+)?(hour|day|week|month)s?\b", re.I)
_APPROX_CUE = re.compile(r"\b(about|around|roughly|approximately|nearly|almost|couple|or so|last|past)\b|~", re.I)


def parse_duration_text(text: str) -> tuple[int, DurationUnit] | None:
    """Read a number and unit out of the speaker's own words, e.g. "about five days" -> (5, DAYS)."""
    for m in _DURATION_RE.finditer(text):
        raw = m.group(1).lower()
        n = int(raw) if raw.isdigit() else _WORD_NUMBERS.get(raw)
        if n is not None and 1 <= n <= 365:
            return n, _UNIT_WORDS[m.group(2).lower()]
    return None


_HOURS = {DurationUnit.HOURS: 1, DurationUnit.DAYS: 24, DurationUnit.WEEKS: 24 * 7, DurationUnit.MONTHS: 24 * 30}


def duration_hours(d: Duration) -> int:
    return d.value * _HOURS[d.unit]


# ----------------------------------------------------------------------------- results
@dataclass
class Accepted:
    kind: ObservationKind
    symptom: SymptomCode | None
    label: str | None
    status: Status
    source: Source
    confidence: Confidence
    attributes: Attributes
    evidence: list[Evidence]
    warnings: list[str] = field(default_factory=list)


@dataclass
class Outcome:
    accepted: Accepted | None = None
    held: HeldObservation | None = None
    rejection: Rejection | None = None


_ALLOWED_MODEL_SOURCES = {Source.PATIENT_REPORTED, Source.DOCTOR_OBSERVED}
_EXPECTED_SPEAKER = {Source.PATIENT_REPORTED: Speaker.PATIENT, Source.DOCTOR_OBSERVED: Speaker.DOCTOR}


def _reject(reason: RejectionReason, mo: ModelObservation, utterance_id: str | None = None) -> Outcome:
    return Outcome(rejection=Rejection(reason_code=reason, utterance_id=utterance_id, symptom=mo.symptom))


def validate_observation(
    mo: ModelObservation,
    utterances: dict[str, Utterance],
    new_ids: set[str],
) -> Outcome:
    """Validate one model observation. ``utterances`` holds every utterance in the request; ``new_ids``
    are the ones that may support a STATEMENT."""
    # --- vocabulary / label shape --------------------------------------------------------------
    if mo.kind == ObservationKind.SYMPTOM:
        if mo.symptom is None:
            return _reject(RejectionReason.INVALID_SYMPTOM_OR_LABEL, mo)
        if mo.symptom == SymptomCode.OTHER and not (mo.label and re.match(LABEL_PATTERN, mo.label)):
            return _reject(RejectionReason.INVALID_SYMPTOM_OR_LABEL, mo)
        if mo.symptom != SymptomCode.OTHER and mo.label is not None:
            return _reject(RejectionReason.INVALID_SYMPTOM_OR_LABEL, mo)
        if mo.status == Status.UNRESOLVED:
            return _reject(RejectionReason.INVALID_STATUS, mo)  # only the reconciler or the doctor may mark UNRESOLVED
    else:
        if mo.symptom is not None or not (mo.label and re.match(LABEL_PATTERN, mo.label)):
            return _reject(RejectionReason.INVALID_SYMPTOM_OR_LABEL, mo)
    if contains_dose_text(mo.label):
        return _reject(RejectionReason.DOSE_OR_PRESCRIPTION_TEXT, mo)

    # --- source -------------------------------------------------------------------------------
    if mo.source not in _ALLOWED_MODEL_SOURCES:
        # includes DOCTOR_CONFIRMED: only an explicit doctor action may create it
        return _reject(RejectionReason.SOURCE_NOT_ALLOWED, mo)
    if mo.kind == ObservationKind.PATIENT_STATED_CONDITION and mo.source != Source.PATIENT_REPORTED:
        return _reject(RejectionReason.DIAGNOSIS_NOT_SUPPORTED, mo)

    # --- evidence -----------------------------------------------------------------------------
    evidence: list[Evidence] = []
    seen: set[tuple[str, int, int]] = set()
    for e in mo.evidence:
        u = utterances.get(e.utterance_id)
        if u is None:
            return _reject(RejectionReason.UNKNOWN_UTTERANCE, mo, e.utterance_id)
        if e.role == EvidenceRole.STATEMENT and e.utterance_id not in new_ids:
            return _reject(RejectionReason.STATEMENT_NOT_IN_NEW_UTTERANCES, mo, e.utterance_id)
        span = locate_quote(u.text, e.quote)
        if span is None:
            return _reject(RejectionReason.QUOTE_NOT_IN_UTTERANCE, mo, e.utterance_id)
        quote = u.text[span[0] : span[1]]  # re-cut from the source: verbatim by construction
        if contains_dose_text(quote):
            return _reject(RejectionReason.DOSE_OR_PRESCRIPTION_TEXT, mo, e.utterance_id)
        key = (e.utterance_id, span[0], span[1])
        if key in seen:
            continue
        seen.add(key)
        evidence.append(Evidence(utterance_id=e.utterance_id, role=e.role, quote=quote, char_start=span[0], char_end=span[1]))
    statements = [e for e in evidence if e.role == EvidenceRole.STATEMENT]
    if not statements:
        return _reject(RejectionReason.MISSING_STATEMENT_EVIDENCE, mo)

    # --- speaker ------------------------------------------------------------------------------
    expected = _EXPECTED_SPEAKER[mo.source]
    speakers = {utterances[e.utterance_id].speaker for e in statements}
    if Speaker.UNATTRIBUTED in speakers:
        first = next(e for e in statements if utterances[e.utterance_id].speaker == Speaker.UNATTRIBUTED)
        return Outcome(
            held=HeldObservation(
                utterance_id=first.utterance_id,
                kind=mo.kind,
                symptom=mo.symptom,
                label=mo.label,
                status=mo.status,
                evidence=evidence[:4],
            )
        )
    if speakers != {expected}:
        return _reject(RejectionReason.SPEAKER_MISMATCH, mo, statements[0].utterance_id)

    # --- status rules -------------------------------------------------------------------------
    status = mo.status
    warnings: list[str] = []
    if mo.kind == ObservationKind.PATIENT_STATED_CONDITION and status == Status.PRESENT:
        status = Status.UNRESOLVED  # "the patient says they have X" is never a confirmed diagnosis
        warnings.append("PATIENT_STATED_CONDITION_UNVERIFIED")

    # --- attributes: keep only what can be checked against the speaker's own words --------------
    attributes, attr_warnings = _sanitise_attributes(mo, status, statements, utterances)
    if attributes is None:
        return _reject(RejectionReason.DOSE_OR_PRESCRIPTION_TEXT, mo)
    warnings += attr_warnings

    return Outcome(
        accepted=Accepted(
            kind=mo.kind, symptom=mo.symptom, label=mo.label, status=status, source=mo.source,
            confidence=mo.confidence, attributes=attributes, evidence=evidence, warnings=warnings,
        )
    )


def _sanitise_attributes(
    mo: ModelObservation, status: Status, statements: list[Evidence], utterances: dict[str, Utterance]
) -> tuple[Attributes | None, list[str]]:
    a = mo.attributes.model_copy(deep=True)
    warnings: list[str] = []
    if status in (Status.ABSENT, Status.UNKNOWN):
        if a != Attributes():
            warnings.append("ATTRIBUTES_DROPPED_FOR_NON_PRESENT")
        return Attributes(), warnings
    if a.duration is not None:
        d = a.duration
        if contains_dose_text(d.text):
            return None, warnings
        statement_text = " ".join(utterances[e.utterance_id].text for e in statements)
        span = None
        for e in statements:
            span = locate_quote(utterances[e.utterance_id].text, d.text)
            if span:
                break
        if span is None:
            a.duration = None
            warnings.append("DURATION_NOT_IN_STATEMENT")
        else:
            parsed = parse_duration_text(d.text) or parse_duration_text(statement_text)
            approximate = bool(_APPROX_CUE.search(d.text))
            if parsed is None:
                a.duration = Duration(value=d.value, unit=d.unit, approximate=True, text=d.text)
                warnings.append("DURATION_UNVERIFIED")
            else:
                if parsed != (d.value, d.unit):
                    warnings.append("DURATION_CORRECTED_FROM_TEXT")
                a.duration = Duration(value=parsed[0], unit=parsed[1], approximate=approximate, text=d.text)
    return a, warnings
