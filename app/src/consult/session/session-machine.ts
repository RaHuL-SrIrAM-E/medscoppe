/**
 * Consultation session state machine. Pure TypeScript: no timers, no DOM, no Three.js.
 *
 * Three INDEPENDENT regions, so that pausing, extracting and speaking never block or imply each other:
 *   1. lifecycle  : IDLE, STARTING, LISTENING, PAUSED, ENDED, FAILED   (what the input side is doing)
 *   2. extraction : number of extraction requests in flight          (what the clinical-extraction side is doing)
 *   3. speaking   : IDLE | SPEAKING                                    (what MEDSCOPE's voice is doing)
 *
 * An event that is not valid in the current state returns an error and leaves the state untouched; it never throws.
 */

export type Lifecycle = 'IDLE' | 'STARTING' | 'LISTENING' | 'PAUSED' | 'ENDED' | 'FAILED';
export type SpeakingState = 'IDLE' | 'SPEAKING';

export type LifecycleEventType = 'START' | 'PROVIDER_STARTED' | 'PROVIDER_FAILED' | 'PAUSE' | 'RESUME' | 'END';
export type SessionEvent =
  | { type: 'START' }
  | { type: 'PROVIDER_STARTED' }
  | { type: 'PROVIDER_FAILED'; reason: string; fatal: boolean }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'END' }
  | { type: 'INPUT_EXHAUSTED' }
  | { type: 'EXTRACTION_STARTED' }
  | { type: 'EXTRACTION_SUCCEEDED' }
  | { type: 'EXTRACTION_FAILED'; error: string }
  | { type: 'SPEECH_STARTED' }
  | { type: 'SPEECH_ENDED' }
  | { type: 'SPEECH_INTERRUPTED' };

export interface SessionState {
  readonly lifecycle: Lifecycle;
  readonly extraction: {
    readonly inFlight: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly lastError: string | null;
  };
  readonly speaking: SpeakingState;
  /** Set by a provider failure; cleared by START (retry) and RESUME. */
  readonly failure: { readonly reason: string; readonly fatal: boolean } | null;
  /** A finite input source (the scripted consultation) has delivered everything. */
  readonly inputExhausted: boolean;
}

export interface TransitionError {
  readonly code: 'INVALID_TRANSITION';
  readonly from: Lifecycle;
  readonly event: SessionEvent['type'];
  readonly detail: string;
}

export interface TransitionResult {
  readonly state: SessionState;
  readonly error: TransitionError | null;
  /** False when the event was valid but changed nothing. */
  readonly changed: boolean;
}

/**
 * The lifecycle transition table (the source of truth, also printed in docs/phase2-architecture.md).
 * PROVIDER_FAILED is conditional on `fatal`, see `transition`.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<Lifecycle, Readonly<Partial<Record<LifecycleEventType, Lifecycle>>>>> = {
  IDLE: { START: 'STARTING' },
  STARTING: { PROVIDER_STARTED: 'LISTENING', PROVIDER_FAILED: 'FAILED', END: 'ENDED' },
  LISTENING: { PAUSE: 'PAUSED', END: 'ENDED', PROVIDER_FAILED: 'PAUSED' /* non-fatal; fatal goes to FAILED */ },
  PAUSED: { RESUME: 'LISTENING', END: 'ENDED', PROVIDER_FAILED: 'PAUSED' /* non-fatal; fatal goes to FAILED */ },
  FAILED: { START: 'STARTING', END: 'ENDED' },
  ENDED: {},
};

export function createSession(): SessionState {
  return {
    lifecycle: 'IDLE',
    extraction: { inFlight: 0, succeeded: 0, failed: 0, lastError: null },
    speaking: 'IDLE',
    failure: null,
    inputExhausted: false,
  };
}

const invalid = (state: SessionState, event: SessionEvent, detail: string): TransitionResult => ({
  state,
  error: { code: 'INVALID_TRANSITION', from: state.lifecycle, event: event.type, detail },
  changed: false,
});
const moved = (state: SessionState): TransitionResult => ({ state, error: null, changed: true });

export function transition(state: SessionState, event: SessionEvent): TransitionResult {
  switch (event.type) {
    // ------------------------------------------------------------------------------- lifecycle region
    case 'START':
    case 'PROVIDER_STARTED':
    case 'PAUSE':
    case 'RESUME':
    case 'END': {
      const next = LIFECYCLE_TRANSITIONS[state.lifecycle][event.type];
      if (!next) return invalid(state, event, `${event.type} is not allowed while ${state.lifecycle}`);
      const clearFailure = event.type === 'START' || event.type === 'RESUME';
      return moved({
        ...state,
        lifecycle: next,
        failure: clearFailure ? null : state.failure,
        inputExhausted: event.type === 'START' ? false : state.inputExhausted,
      });
    }
    case 'PROVIDER_FAILED': {
      const allowed = state.lifecycle === 'STARTING' || state.lifecycle === 'LISTENING' || state.lifecycle === 'PAUSED';
      if (!allowed) return invalid(state, event, `PROVIDER_FAILED is not allowed while ${state.lifecycle}`);
      const next: Lifecycle = event.fatal || state.lifecycle === 'STARTING' ? 'FAILED' : 'PAUSED';
      return moved({ ...state, lifecycle: next, failure: { reason: event.reason, fatal: event.fatal || state.lifecycle === 'STARTING' } });
    }
    case 'INPUT_EXHAUSTED': {
      if (state.lifecycle !== 'LISTENING' && state.lifecycle !== 'PAUSED') {
        return invalid(state, event, `INPUT_EXHAUSTED is not allowed while ${state.lifecycle}`);
      }
      return state.inputExhausted ? { state, error: null, changed: false } : moved({ ...state, inputExhausted: true });
    }

    // ------------------------------------------------------------------------------- extraction region
    // May start while paused (queued work) and may drain after the session ended or failed.
    case 'EXTRACTION_STARTED': {
      if (state.lifecycle === 'IDLE' || state.lifecycle === 'STARTING') {
        return invalid(state, event, `no extraction can start while ${state.lifecycle}`);
      }
      return moved({ ...state, extraction: { ...state.extraction, inFlight: state.extraction.inFlight + 1 } });
    }
    case 'EXTRACTION_SUCCEEDED': {
      if (state.extraction.inFlight === 0) return invalid(state, event, 'no extraction is in flight');
      return moved({ ...state, extraction: { ...state.extraction, inFlight: state.extraction.inFlight - 1, succeeded: state.extraction.succeeded + 1, lastError: null } });
    }
    case 'EXTRACTION_FAILED': {
      if (state.extraction.inFlight === 0) return invalid(state, event, 'no extraction is in flight');
      return moved({ ...state, extraction: { ...state.extraction, inFlight: state.extraction.inFlight - 1, failed: state.extraction.failed + 1, lastError: event.error } });
    }

    // ------------------------------------------------------------------------------- speaking region
    case 'SPEECH_STARTED': {
      if (state.lifecycle === 'IDLE' || state.lifecycle === 'STARTING') return invalid(state, event, `no speech while ${state.lifecycle}`);
      if (state.speaking === 'SPEAKING') return invalid(state, event, 'already speaking: interrupt first');
      return moved({ ...state, speaking: 'SPEAKING' });
    }
    case 'SPEECH_ENDED':
    case 'SPEECH_INTERRUPTED': {
      if (state.speaking !== 'SPEAKING') return invalid(state, event, 'not speaking');
      return moved({ ...state, speaking: 'IDLE' });
    }
  }
}

// ----------------------------------------------------------------------------------------------- selectors
export const isListening = (s: SessionState): boolean => s.lifecycle === 'LISTENING';
export const isExtracting = (s: SessionState): boolean => s.extraction.inFlight > 0;
export const isSpeaking = (s: SessionState): boolean => s.speaking === 'SPEAKING';
/** Input can no longer arrive: the session is over or failed. */
export const isInputClosed = (s: SessionState): boolean => s.lifecycle === 'ENDED' || s.lifecycle === 'FAILED';

export function canTransition(state: SessionState, event: SessionEvent): boolean {
  return transition(state, event).error === null;
}
