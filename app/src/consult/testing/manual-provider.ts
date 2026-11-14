/** A provider the test drives by hand, so it can deliver what a script never would (unattributed speech, repeats, conflicts). */
import type { Utterance } from '../contracts/schema.js';
import type { ProviderCapabilities, ProviderEvent, ProviderListener, TranscriptionProvider } from '../transcription/transcription-provider.js';

export class ManualProvider implements TranscriptionProvider {
  readonly id = 'manual';
  readonly kind = 'SCRIPTED' as const;
  readonly capabilities: ProviderCapabilities = { live: false, partialResults: true, timestamps: 'NONE', speakerAttribution: 'NONE', audioLeavesDevice: false, description: 'manual test provider' };
  private listeners = new Set<ProviderListener>();
  stopped = false;
  async start(): Promise<void> { this.emit({ type: 'started' }); }
  pause(): void {}
  resume(): void {}
  stop(): void { this.stopped = true; }
  subscribe(f: ProviderListener): () => void { this.listeners.add(f); return () => this.listeners.delete(f); }
  emit(e: ProviderEvent): void { for (const f of this.listeners) f(e); }
  say(u: Partial<Utterance> & { id: string; text: string }): void {
    this.emit({ type: 'final', utterance: { speaker: 'PATIENT', speaker_basis: 'SCRIPTED', start_ms: 0, end_ms: 1000, ...u } as Utterance });
  }
}
