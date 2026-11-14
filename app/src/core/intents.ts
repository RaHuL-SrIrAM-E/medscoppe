/**
 * Application intents. Hand gestures, voice commands and the desktop adapter
 * all emit these; systems react to them. Nothing else may mutate anatomy state.
 * Pure TypeScript: no Three.js, no DOM.
 */
import type { AnatomicalSystemId } from '../design/tokens.js';

export type IntentSource = 'hand' | 'voice' | 'desktop' | 'script';

export type Intent =
  | { type: 'SELECT_STRUCTURE'; structureId: string }
  | { type: 'SET_ANATOMICAL_SYSTEM'; system: AnatomicalSystemId }
  | { type: 'ISOLATE_STRUCTURE'; structureId: string }
  | { type: 'SHOW_CLINICAL_INFORMATION'; structureId: string }
  | { type: 'ROTATE_MODEL'; phase: 'start' | 'end'; yawDegrees?: number }
  | { type: 'START_CONSULTATION' }
  | { type: 'PAUSE_LISTENING' };

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
