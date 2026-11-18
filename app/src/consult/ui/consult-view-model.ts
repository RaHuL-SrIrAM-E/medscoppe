/**
 * Pure view models for the consultation UI: what the controls say, which beads exist, what the card shows and which
 * review actions are offered. No Three.js and no DOM, so every rule here is unit-tested. The spatial systems only paint
 * what these functions return.
 *
 * Wording rules: nothing here states a diagnosis. A patient-stated condition is always labelled as the patient's own
 * statement and offers no confirmation. Status colours never use alarm semantics for observations.
 */
import { REFERENCE_NOTICE, commonCauses, conditionReference, referenceByKey, type XrayFinding } from './condition-reference.js';
import type { Observation, Utterance } from '../contracts/schema.js';
import type { Intent } from '../../core/intents.js';
import { visibleObservations, type ConsultationState } from '../context/context-store.js';
import type { SessionSnapshot } from '../session/consultation-session.js';
import { LABELS, liveLabel } from './consult-labels.js';

// ---------------------------------------------------------------------------------------------- names
const SYMPTOM_NAMES: Record<string, string> = {
  COUGH: 'Cough',
  FEVER: 'Fever',
  DYSPNOEA: 'Dyspnoea',
  CHEST_PAIN: 'Chest pain',
  WHEEZE: 'Wheeze',
  HAEMOPTYSIS: 'Haemoptysis',
  SORE_THROAT: 'Sore throat',
  FATIGUE: 'Fatigue',
  NASAL_CONGESTION: 'Nasal congestion',
  HEADACHE: 'Headache',
};

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The name of what was reported, without the status. */
export function observationName(o: Observation): string {
  if (o.symptom && o.symptom !== 'OTHER') return SYMPTOM_NAMES[o.symptom] ?? titleCase(o.symptom.toLowerCase());
  return titleCase(o.label ?? 'Other');
}

/** Symptoms the UI may show NEAR the chest, as an orientation aid only. Everything else floats free (systemic). */
const CHEST_ASSOCIATED = new Set(['COUGH', 'DYSPNOEA', 'WHEEZE', 'HAEMOPTYSIS', 'CHEST_PAIN']);

export type BeadAnchor = 'CHEST_REGION' | 'SYSTEMIC';
export type Origin = 'PATIENT' | 'DOCTOR_OBSERVED' | 'DOCTOR_CONFIRMED';
export type Presence = 'PRESENT' | 'ABSENT' | 'UNKNOWN' | 'UNRESOLVED' | 'MENTIONED';

export interface BeadModel {
  readonly observationId: string;
  /** Short label drawn next to the bead. */
  readonly label: string;
  readonly origin: Origin;
  readonly presence: Presence;
  readonly anchor: BeadAnchor;
  /** A patient-stated condition: shown as the patient's statement, never confirmable. */
  readonly isCondition: boolean;
  readonly revision: number;
}

function originOf(o: Observation): Origin {
  if (o.source === 'DOCTOR_CONFIRMED') return 'DOCTOR_CONFIRMED';
  if (o.source === 'DOCTOR_OBSERVED') return 'DOCTOR_OBSERVED';
  return 'PATIENT';
}

export function beadLabel(o: Observation): string {
  const name = observationName(o);
  if (o.kind === 'PATIENT_STATED_CONDITION') return `${name} (patient says)`;
  switch (o.status) {
    case 'ABSENT':
      return `No ${name.toLowerCase()}`;
    case 'UNKNOWN':
      return `${name}: not clear`;
    case 'UNRESOLVED':
      return `${name}: conflict`;
    default:
      return name;
  }
}

export function deriveBeads(context: ConsultationState): BeadModel[] {
  return visibleObservations(context).map((o) => ({
    observationId: o.id,
    label: beadLabel(o),
    origin: originOf(o),
    presence: o.kind === 'PATIENT_STATED_CONDITION' ? 'MENTIONED' : o.status,
    anchor: o.kind === 'SYMPTOM' && o.symptom && CHEST_ASSOCIATED.has(o.symptom) ? 'CHEST_REGION' : 'SYSTEMIC',
    isCondition: o.kind === 'PATIENT_STATED_CONDITION',
    revision: o.revision,
  }));
}

// ---------------------------------------------------------------------------------------------- card
export type XrayMode = 'OFF' | 'FILM' | 'LOCATE';

export interface XrayModel {
  readonly conditionName: string;
  readonly finding: XrayFinding;
  readonly mode: XrayMode;
  readonly buttonLabel: string;
  /** What pressing the X-ray button emits: OFF -> FILM -> LOCATE -> OFF. */
  readonly nextIntent: Intent;
}

export type ReviewPanel = 'CORRECT' | 'NOTE' | 'REFERENCE';

/** One tappable option on the card's review row. The intent is what pressing it emits. */
export interface CardOption {
  readonly label: string;
  readonly intent: Intent;
}

/** Short fixed notes: a doctor annotates with one press, no keyboard and no free-text panel. */
export const PRESET_NOTES = ['Needs follow-up', 'Patient unsure', 'Clarified with patient'] as const;

export interface CardModel {
  readonly observationId: string;
  readonly title: string;
  readonly presenceLine: string;
  readonly origin: Origin;
  readonly sourceLine: string;
  /** Whether a doctor has explicitly confirmed this. Never inferred. */
  readonly confirmed: boolean;
  readonly confirmLine: string;
  readonly durationLine: string | null;
  readonly evidenceLabel: string;
  readonly evidenceQuote: string;
  readonly placementNote: string;
  /** Extra caution text (condition statements, conflicts). */
  readonly notice: string | null;
  readonly severityLine: string | null;
  readonly revisionLine: string | null;
  readonly noteLine: string | null;
  readonly actions: {
    readonly confirm: boolean;
    readonly reject: boolean;
    readonly resolve: boolean;
    readonly correct: boolean;
    readonly annotate: boolean;
    readonly reference: boolean;
  };
  readonly panel: ReviewPanel | null;
  /** Wording of the reference button: tests and medicines for a condition, possible causes for a symptom. */
  readonly referenceLabel: string;
  /** Set only in the reference view of a condition that has an illustrative chest film. */
  readonly xray: XrayModel | null;
  /** Educational tests and medicine classes for a patient-stated condition; shown only while the reference view is open. */
  readonly reference: { readonly heading: string; readonly testsLine: string; readonly medicinesLine: string; readonly notice: string; /** Back returns to the list of causes rather than closing the view. */ readonly backToList: boolean } | null;
  /** Options for the open review row (empty when no row is open). */
  readonly options: readonly CardOption[];
}

const PRESENCE_TEXT: Record<Presence, string> = {
  PRESENT: 'Reported present',
  ABSENT: 'Reported absent',
  UNKNOWN: 'Not clear from what was said',
  UNRESOLVED: 'Unresolved: conflicting statements',
  MENTIONED: 'Mentioned by the patient',
};

const SOURCE_TEXT: Record<Origin, string> = {
  PATIENT: 'Source: patient-reported',
  DOCTOR_OBSERVED: 'Source: doctor-observed (stated by the doctor)',
  DOCTOR_CONFIRMED: 'Source: doctor-confirmed',
};

const speakerWord = (s: Utterance['speaker'] | undefined): string => (s === 'PATIENT' ? 'Patient said' : s === 'DOCTOR' ? 'Doctor said' : 'Heard');

export function deriveCard(
  context: ConsultationState,
  utterances: readonly Utterance[],
  observationId: string | null,
  panel: ReviewPanel | null = null,
  refCondition: string | null = null,
  xrayMode: XrayMode = 'OFF',
): CardModel | null {
  if (!observationId) return null;
  const o = visibleObservations(context).find((x) => x.id === observationId);
  if (!o) return null;
  const isCondition = o.kind === 'PATIENT_STATED_CONDITION';
  const origin = originOf(o);
  const evidence = o.evidence.find((e) => e.role === 'STATEMENT') ?? o.evidence[0]!;
  const speaker = utterances.find((u) => u.id === evidence.utterance_id)?.speaker;
  const unresolved = o.status === 'UNRESOLVED' && !isCondition;
  const confirmed = o.source === 'DOCTOR_CONFIRMED';

  const conflictQuotes = o.conflicts_with
    .map((id) => visibleObservations(context).find((x) => x.id === id))
    .filter((x): x is Observation => !!x)
    .map((x) => x.evidence.find((e) => e.role === 'STATEMENT')?.quote)
    .filter((q): q is string => !!q);

  let notice: string | null = null;
  if (isCondition) notice = 'The patient mentioned this. It is not a diagnosis and cannot be confirmed here.';
  else if (unresolved) {
    notice = conflictQuotes.length > 0 ? `Also heard: "${conflictQuotes[0]}". Choose which statement to keep.` : 'Conflicting statements. Choose which to keep.';
  }

  const d = o.attributes.duration;
  const canCorrect = !isCondition && !unresolved;
  const causes = !isCondition && o.status === 'PRESENT' ? commonCauses(o.symptom) : [];
  const canReference = isCondition || causes.length > 0;
  const ref = isCondition ? conditionReference(o.label) : referenceByKey(causes.some((c) => c.key === refCondition) ? refCondition : null);
  const listing = !isCondition && causes.length > 0 && !ref;
  const openPanel = (panel === 'CORRECT' && !canCorrect) || (panel === 'REFERENCE' && !canReference) ? null : panel;
  const options: CardOption[] = [];
  if (openPanel === 'CORRECT') {
    if (o.status !== 'PRESENT') options.push({ label: 'Mark present', intent: { type: 'CORRECT_OBSERVATION', observationId: o.id, status: 'PRESENT' } });
    if (o.status !== 'ABSENT') options.push({ label: 'Mark absent', intent: { type: 'CORRECT_OBSERVATION', observationId: o.id, status: 'ABSENT' } });
    for (const [label, severity] of [['Mild', 'MILD'], ['Moderate', 'MODERATE'], ['Severe', 'SEVERE']] as const) {
      if (o.attributes.severity !== severity) options.push({ label: `Severity: ${label}`, intent: { type: 'CORRECT_OBSERVATION', observationId: o.id, severity } });
    }
  } else if (openPanel === 'REFERENCE' && listing) {
    for (const c of causes) options.push({ label: c.name, intent: { type: 'SET_REFERENCE_CONDITION', condition: c.key } });
  } else if (openPanel === 'NOTE') {
    for (const note of PRESET_NOTES) {
      if (o.review.note !== note) options.push({ label: note, intent: { type: 'ANNOTATE_OBSERVATION', observationId: o.id, note } });
    }
  }
  const corrected = o.review.state === 'CORRECTED';
  return {
    observationId: o.id,
    title: observationName(o),
    presenceLine: PRESENCE_TEXT[isCondition ? 'MENTIONED' : o.status],
    origin,
    sourceLine: SOURCE_TEXT[origin],
    confirmed,
    confirmLine: corrected ? 'Corrected by a doctor (explicit action)' : confirmed ? 'Confirmed by a doctor (explicit action)' : 'Not confirmed by a doctor',
    durationLine: d ? `Duration: ${d.text}${d.approximate ? ' (approximate)' : ''}` : null,
    evidenceLabel: speakerWord(speaker),
    evidenceQuote: `"${evidence.quote}"`,
    placementNote:
      CHEST_ASSOCIATED.has(o.symptom ?? '') && o.kind === 'SYMPTOM'
        ? 'Drawn near the chest for orientation only. Not a finding about any structure.'
        : 'Systemic or general. Not tied to an anatomical location.',
    notice,
    severityLine: o.attributes.severity ? `Severity: ${titleCase(o.attributes.severity.toLowerCase())}` : null,
    revisionLine: o.revision > 1 ? `Revision ${o.revision}. Earlier revisions and the original quote are kept.` : null,
    noteLine: o.review.note ? `Doctor's note: ${o.review.note}` : null,
    actions: {
      confirm: !isCondition && !unresolved && !(confirmed && (o.review.state === 'CONFIRMED' || corrected)),
      reject: true,
      resolve: !isCondition && unresolved && o.conflicts_with.length > 0,
      correct: canCorrect,
      annotate: true,
      reference: canReference,
    },
    panel: openPanel,
    referenceLabel: isCondition ? 'Tests & medicines' : 'Possible causes',
    xray:
      openPanel === 'REFERENCE' && ref?.xray
        ? {
            conditionName: ref.name,
            finding: ref.xray,
            mode: xrayMode,
            buttonLabel: xrayMode === 'OFF' ? 'View X-ray' : xrayMode === 'FILM' ? 'Show in body' : 'Hide X-ray',
            nextIntent: { type: 'SET_XRAY', mode: xrayMode === 'OFF' ? 'FILM' : xrayMode === 'FILM' ? 'LOCATE' : 'OFF' },
          }
        : null,
    reference:
      openPanel === 'REFERENCE'
        ? listing
          ? {
              heading: `Commonly considered causes of ${observationName(o).toLowerCase()}`,
              testsLine: 'Choose one to see its tests and medicine classes. These are prompts for the doctor, not a diagnosis.',
              medicinesLine: '',
              notice: REFERENCE_NOTICE,
              backToList: false,
            }
          : {
              heading: ref && !isCondition ? `${ref.name} (possible cause of ${observationName(o).toLowerCase()})` : 'Educational reference',
              testsLine: ref ? `Tests to consider: ${ref.tests.join('; ')}` : 'No reference entry for this condition yet.',
              medicinesLine: ref ? `Medicine classes: ${ref.medicines.join('; ')}` : '',
              notice: REFERENCE_NOTICE,
              backToList: !isCondition,
            }
        : null,
    options,
  };
}

// ---------------------------------------------------------------------------------------------- controls
export type ControlLifecycle = 'READY' | 'STARTING' | 'LISTENING' | 'PAUSED' | 'ENDED' | 'COMPLETE' | 'FAILED';
export type ExtractionSource = 'BACKEND' | 'OFFLINE_FIXTURE';

/** What the app knows about the extraction service before and between sessions. */
export interface BackendResolution {
  readonly state: 'UNKNOWN' | 'NOT_CONFIGURED' | 'BACKEND_REPLAY' | 'BACKEND_LIVE' | 'UNREACHABLE';
}

export interface ControlsModel {
  readonly lifecycle: ControlLifecycle;
  readonly lifecycleText: string;
  readonly dataLabel: string;
  readonly extractionLabel: string;
  readonly extractionIsReplay: boolean;
  readonly extractionDetail: string | null;
  readonly primary: { readonly action: 'START_CONSULTATION' | 'PAUSE_LISTENING' | 'RESUME_LISTENING' | 'NONE'; readonly label: string };
  readonly end: boolean;
  readonly retry: boolean;
  readonly busyLine: string | null;
  readonly errorLine: string | null;
  readonly caption: string | null;
  /** The caption is on its way out: paint it dimmer. */
  readonly captionFading: boolean;
  /** Set only when a controlled test fixture is active, so a fixture can never pass for the normal replay. */
  readonly fixtureLine: string | null;
}

export interface CaptionState {
  readonly text: string;
  readonly fading: boolean;
}

export function deriveControls(
  snap: SessionSnapshot | null,
  resolution: BackendResolution,
  source: ExtractionSource | null,
  caption: CaptionState | null = null,
  fixture: string | null = null,
): ControlsModel {
  const lc = snap?.session.lifecycle ?? 'IDLE';
  const complete = lc === 'ENDED' && !!snap?.session.inputExhausted;
  const lifecycle: ControlLifecycle = !snap ? 'READY' : lc === 'IDLE' ? 'READY' : complete ? 'COMPLETE' : lc;

  // extraction label: what has actually happened wins over what is expected
  const mode = snap?.provenance.extraction.mode ?? 'NOT_CONTACTED';
  let extractionLabel: string = LABELS.notStarted;
  let isReplay = false;
  let detail: string | null = null;
  if (mode === 'REPLAY_FIXTURE') {
    extractionLabel = LABELS.replay;
    isReplay = true;
  } else if (mode === 'LIVE_MODEL') {
    extractionLabel = liveLabel(snap?.provenance.extraction.provider ?? null, snap?.provenance.extraction.model ?? null);
  } else if (mode === 'MIXED') {
    extractionLabel = LABELS.mixed;
    isReplay = true;
  } else if (resolution.state === 'UNREACHABLE' || resolution.state === 'NOT_CONFIGURED') {
    extractionLabel = LABELS.replay;
    isReplay = true;
  } else if (resolution.state === 'BACKEND_REPLAY') {
    extractionLabel = LABELS.replay;
    isReplay = true;
  } else if (resolution.state === 'BACKEND_LIVE') {
    extractionLabel = 'EXTRACTION: backend ready (live model)';
  } else {
    extractionLabel = LABELS.checking;
  }
  if (isReplay) {
    const offline = resolution.state === 'UNREACHABLE' || resolution.state === 'NOT_CONFIGURED';
    const src = source ?? (offline ? 'OFFLINE_FIXTURE' : resolution.state === 'BACKEND_REPLAY' ? 'BACKEND' : null);
    detail =
      src === 'OFFLINE_FIXTURE'
        ? resolution.state === 'NOT_CONFIGURED'
          ? 'Offline recorded replay. No backend configured.'
          : 'Backend unreachable: using the offline recorded replay.'
        : src === 'BACKEND'
          ? 'Served by the backend replay provider (hand-authored fixtures).'
          : null;
  }

  let primary: ControlsModel['primary'];
  switch (lifecycle) {
    case 'STARTING':
      primary = { action: 'NONE', label: 'Starting...' };
      break;
    case 'LISTENING':
      primary = { action: 'PAUSE_LISTENING', label: 'Pause' };
      break;
    case 'PAUSED':
      primary = { action: 'RESUME_LISTENING', label: 'Resume' };
      break;
    case 'ENDED':
    case 'COMPLETE':
      primary = { action: 'START_CONSULTATION', label: 'New session' };
      break;
    case 'FAILED':
      primary = { action: 'START_CONSULTATION', label: 'Start again' };
      break;
    default:
      primary = { action: 'START_CONSULTATION', label: 'Start' };
  }

  const inFlight = snap?.session.extraction.inFlight ?? 0;
  const pending = snap?.pendingBatches ?? 0;
  const failed = snap?.failedBatches.length ?? 0;
  const busyLine = inFlight > 0 || pending > 0 ? 'Extracting...' : null;
  let errorLine: string | null = null;
  if (snap?.session.failure) errorLine = `Input failed: ${snap.session.failure.reason}`;
  else if (failed > 0) errorLine = `Extraction failed for ${failed} part${failed > 1 ? 's' : ''}. Nothing was added for ${failed > 1 ? 'them' : 'it'}.`;

  const lifecycleText: Record<ControlLifecycle, string> = {
    READY: 'READY',
    STARTING: 'STARTING',
    LISTENING: 'REPLAYING',
    PAUSED: 'PAUSED',
    ENDED: 'ENDED',
    COMPLETE: 'COMPLETE',
    FAILED: 'FAILED',
  };

  return {
    lifecycle,
    lifecycleText: lifecycleText[lifecycle],
    dataLabel: LABELS.data,
    extractionLabel,
    extractionIsReplay: isReplay,
    extractionDetail: detail,
    primary,
    end: lifecycle === 'STARTING' || lifecycle === 'LISTENING' || lifecycle === 'PAUSED',
    retry: failed > 0,
    busyLine,
    errorLine,
    caption: caption?.text ?? null,
    captionFading: caption?.fading ?? false,
    fixtureLine: fixture ? `TEST FIXTURE: ${fixture}` : null,
  };
}
