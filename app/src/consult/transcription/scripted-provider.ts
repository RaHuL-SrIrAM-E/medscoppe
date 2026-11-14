/**
 * ScriptedProvider: replays a synthetic consultation with explicit speakers and realistic timing.
 *
 * It is a real TranscriptionProvider: it emits partial and final results over time, can be paused and resumed (the
 * script clock freezes), and says plainly that it is scripted. It never produces clinical content itself; the
 * utterances come from the fixture and go through the real session, extraction service and context store.
 */
import { Utterance, type Utterance as UtteranceType } from '../contracts/schema.js';
import type { Cancel, Scheduler } from '../core/scheduler.js';
import type { ProviderCapabilities, ProviderEvent, ProviderListener, TranscriptionProvider } from './transcription-provider.js';

export interface ScriptedTranscript {
  readonly provenance: string;
  readonly consultation_id: string;
  readonly batches: readonly { readonly label: string; readonly utterances: readonly unknown[] }[];
}

export interface ScriptedOptions {
  /** Script time per real time. 1 = real time. */
  readonly speed?: number;
  /** Silence after the last utterance before the script reports that it is exhausted. */
  readonly tailMs?: number;
}

type Item =
  | { readonly t: number; readonly kind: 'partial'; readonly utterance: UtteranceType; readonly text: string }
  | { readonly t: number; readonly kind: 'final'; readonly utterance: UtteranceType }
  | { readonly t: number; readonly kind: 'exhausted' };

const MAX_PARTIALS = 4;

export class ScriptedProvider implements TranscriptionProvider {
  readonly kind = 'SCRIPTED' as const;
  readonly id: string;
  readonly provenance: string;
  readonly capabilities: ProviderCapabilities = {
    live: false,
    partialResults: true,
    timestamps: 'SCRIPTED',
    speakerAttribution: 'SCRIPTED',
    audioLeavesDevice: false,
    description: 'Scripted synthetic consultation. No microphone, no audio, no real patient.',
  };

  private readonly timeline: readonly Item[];
  private readonly speed: number;
  private listeners = new Set<ProviderListener>();
  private status: 'idle' | 'running' | 'paused' | 'stopped' | 'done' = 'idle';
  private index = 0;
  private scriptBase = 0; // script time at the last event or pause
  private resumedAt = 0; // scheduler time when the clock last started running
  private cancel: Cancel | null = null;

  constructor(script: ScriptedTranscript, private readonly scheduler: Scheduler, options: ScriptedOptions = {}) {
    this.speed = options.speed ?? 1;
    if (!(this.speed > 0)) throw new Error('speed must be positive');
    this.id = `scripted:${script.consultation_id}`;
    this.provenance = script.provenance;
    this.timeline = buildTimeline(script, options.tailMs ?? 500);
  }

  /** Every utterance the script will deliver, in order. For display and tests only. */
  get utterances(): readonly UtteranceType[] {
    return this.timeline.flatMap((i) => (i.kind === 'final' ? [i.utterance] : []));
  }

  subscribe(listener: ProviderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.status !== 'idle') throw new Error('ScriptedProvider can only be started once');
    this.status = 'running';
    this.scriptBase = 0;
    this.resumedAt = this.scheduler.now();
    this.emit({ type: 'started' });
    this.scheduleNext();
  }

  pause(): void {
    if (this.status !== 'running') return;
    this.cancel?.();
    this.cancel = null;
    this.scriptBase = this.scriptNow();
    this.status = 'paused';
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.resumedAt = this.scheduler.now();
    this.status = 'running';
    this.scheduleNext();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
    this.status = 'stopped';
  }

  private scriptNow(): number {
    return this.status === 'running' ? this.scriptBase + (this.scheduler.now() - this.resumedAt) * this.speed : this.scriptBase;
  }

  private scheduleNext(): void {
    const item = this.timeline[this.index];
    if (!item || this.status !== 'running') return;
    const delay = Math.max(0, (item.t - this.scriptNow()) / this.speed);
    this.cancel = this.scheduler.schedule(delay, () => this.fire(item));
  }

  private fire(item: Item): void {
    if (this.status !== 'running') return;
    this.scriptBase = item.t;
    this.resumedAt = this.scheduler.now();
    this.index += 1;
    this.cancel = null;
    if (item.kind === 'partial') {
      this.emit({ type: 'partial', utteranceId: item.utterance.id, speaker: item.utterance.speaker, text: item.text });
    } else if (item.kind === 'final') {
      this.emit({ type: 'final', utterance: item.utterance });
    } else {
      this.status = 'done';
      this.emit({ type: 'exhausted' });
      return;
    }
    this.scheduleNext();
  }

  private emit(event: ProviderEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function buildTimeline(script: ScriptedTranscript, tailMs: number): Item[] {
  const utterances: UtteranceType[] = [];
  const ids = new Set<string>();
  for (const batch of script.batches) {
    for (const raw of batch.utterances) {
      const u = Utterance.parse(raw);
      if (u.speaker === 'UNATTRIBUTED') throw new Error(`scripted utterance ${u.id} must have an explicit speaker`);
      if (u.speaker_basis !== 'SCRIPTED') throw new Error(`scripted utterance ${u.id} must have speaker_basis SCRIPTED`);
      if (u.start_ms == null || u.end_ms == null) throw new Error(`scripted utterance ${u.id} needs start_ms and end_ms`);
      if (ids.has(u.id)) throw new Error(`duplicate scripted utterance id ${u.id}`);
      ids.add(u.id);
      utterances.push(u);
    }
  }
  const items: Item[] = [];
  let lastEnd = 0;
  for (const u of utterances) {
    const start = u.start_ms!;
    const end = u.end_ms!;
    if (start < lastEnd) throw new Error(`scripted utterance ${u.id} overlaps the previous one`);
    const words = u.text.split(/\s+/).filter(Boolean);
    const partials = Math.min(MAX_PARTIALS, Math.max(0, words.length - 1));
    for (let k = 1; k <= partials; k++) {
      const shown = Math.ceil((words.length * k) / (partials + 1));
      items.push({ t: start + ((end - start) * k) / (partials + 1), kind: 'partial', utterance: u, text: words.slice(0, shown).join(' ') });
    }
    items.push({ t: end, kind: 'final', utterance: u });
    lastEnd = end;
  }
  items.push({ t: lastEnd + tailMs, kind: 'exhausted' });
  return items;
}
