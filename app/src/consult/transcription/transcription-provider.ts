/**
 * Provider-independent transcription interface. Nothing outside src/consult/transcription knows which provider is
 * active, and nothing here is coupled to Gemini or to the extraction layer.
 */
import type { Speaker, Utterance } from '../contracts/schema.js';

export type ProviderKind = 'SCRIPTED' | 'WEB_SPEECH' | 'BACKEND_CHUNKS';

export interface ProviderCapabilities {
  /** True only for real microphone input. The scripted consultation is never live. */
  readonly live: boolean;
  readonly partialResults: boolean;
  readonly timestamps: 'SCRIPTED' | 'LOCAL_CLOCK' | 'NONE';
  readonly speakerAttribution: 'SCRIPTED' | 'MANUAL' | 'NONE';
  /** Whether audio leaves the device (and so must be disclosed before use). */
  readonly audioLeavesDevice: boolean;
  readonly description: string;
}

export type ProviderEvent =
  | { readonly type: 'started' }
  | { readonly type: 'partial'; readonly utteranceId: string; readonly speaker: Speaker; readonly text: string }
  | { readonly type: 'final'; readonly utterance: Utterance }
  /** A finite source (the script) has delivered everything. Live providers never emit this. */
  | { readonly type: 'exhausted' }
  | { readonly type: 'error'; readonly reason: string; readonly fatal: boolean };

export type ProviderListener = (event: ProviderEvent) => void;

export interface TranscriptionProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  /** Begin delivering input. Rejects if the provider cannot start (for example an unsupported browser). */
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  /** Stop for good. A stopped provider never emits again. */
  stop(): void;
  subscribe(listener: ProviderListener): () => void;
}
