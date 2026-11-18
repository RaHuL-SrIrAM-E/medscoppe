/**
 * Application intents. Hand gestures, voice commands and the desktop adapter
 * all emit these; the anatomy store reduces them into state. Nothing else may
 * mutate anatomy state. Pure TypeScript: no Three.js, no DOM.
 */
import type { AnatomicalSystemId } from '../design/tokens.js';

export type IntentSource = 'hand' | 'voice' | 'desktop' | 'script';

export type Intent =
  | { type: 'SELECT_STRUCTURE'; structureId: string }
  | { type: 'CLEAR_SELECTION' }
  | { type: 'HOVER_STRUCTURE'; structureId: string | null }
  | { type: 'SET_ANATOMICAL_SYSTEM'; system: AnatomicalSystemId }
  | { type: 'TOGGLE_SYSTEM_VISIBILITY'; system: AnatomicalSystemId }
  | { type: 'ISOLATE_STRUCTURE'; structureId: string }
  | { type: 'CLEAR_ISOLATION' }
  | { type: 'SHOW_CLINICAL_INFORMATION'; structureId: string }
  | { type: 'HIDE_CLINICAL_INFORMATION' }
  | { type: 'RESET_VIEW' }
  | { type: 'ROTATE_MODEL'; phase: 'start' | 'end'; yawDegrees?: number }
  | { type: 'START_CONSULTATION' }
  | { type: 'PAUSE_LISTENING' }
  | { type: 'RESUME_LISTENING' }
  | { type: 'END_CONSULTATION' }
  | { type: 'RETRY_EXTRACTION' }
  | { type: 'SELECT_OBSERVATION'; observationId: string }
  | { type: 'CLEAR_OBSERVATION_SELECTION' }
  /** Explicit doctor review actions. Only a hand or desktop control press may carry these; see ConsultApp. */
  | { type: 'CONFIRM_OBSERVATION'; observationId: string }
  | { type: 'REJECT_OBSERVATION'; observationId: string }
  | { type: 'RESOLVE_CONFLICT'; observationId: string }
  | { type: 'CORRECT_OBSERVATION'; observationId: string; status?: 'PRESENT' | 'ABSENT'; severity?: 'MILD' | 'MODERATE' | 'SEVERE' }
  | { type: 'ANNOTATE_OBSERVATION'; observationId: string; note: string }
  /** UI-only: which review option row the card shows. Changes no observation. */
  | { type: 'SET_REVIEW_PANEL'; panel: 'CORRECT' | 'NOTE' | 'REFERENCE' | null };

export type IntentEnvelope = { intent: Intent; source: IntentSource };
export type IntentListener = (envelope: IntentEnvelope) => void;

class IntentBus {
  private listeners = new Set<IntentListener>();

  emit(intent: Intent, source: IntentSource): void {
    const envelope: IntentEnvelope = { intent, source };
    for (const listener of this.listeners) {
      listener(envelope);
    }
  }

  /** Returns an unsubscribe function; push it onto `cleanupFuncs`. */
  subscribe(listener: IntentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const intentBus = new IntentBus();
