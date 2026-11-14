/**
 * ConsultationSession: wires a TranscriptionProvider, the session state machine, the extraction client and the
 * append-only context store into one consultation. No UI, no Three.js, no DOM.
 *
 * Pipeline (nothing is pre-populated or shortcut):
 *   provider events -> session machine -> finals -> batches -> extraction queue -> backend -> context store
 *
 * Guarantees:
 *  - Extraction is strictly sequential: one request in flight, so each request carries the latest known observations
 *    and responses can never be applied out of order.
 *  - Repeated provider events (same utterance id) are ignored. Repeated extraction responses (same extraction id)
 *    are applied once. A retry after a lost response re-sends the same batch, which cannot duplicate anything.
 *  - Listening, extraction and speaking are independent regions: pausing never stops queued extraction, and an
 *    extraction in flight never blocks pause, resume or end.
 *  - Whether results come from a recorded replay or a live model is always visible in `banner`.
 */
import { Utterance as UtteranceSchema, type ExtractRequest, type ExtractResponse, type Speaker, type Utterance } from '../contracts/schema.js';
import {
  annotateObservation, applyExtraction, clearHeld, confirmObservation, correctObservation, createConsultation, knownRefs,
  rejectObservation, resolveConflict, type ActionError, type ConsultationState, type CorrectionPatch,
} from '../context/context-store.js';
import type { Cancel, Scheduler } from '../core/scheduler.js';
import { ExtractionError, type BackendHealth, type ExtractionClient } from '../extraction/extraction-client.js';
import type { ProviderEvent, TranscriptionProvider } from '../transcription/transcription-provider.js';
import { canTransition, createSession, transition, type Lifecycle, type SessionEvent, type SessionState, type TransitionResult } from './session-machine.js';

// ---------------------------------------------------------------------------------------------- public types
export type ExtractionMode = 'NOT_CONTACTED' | 'REPLAY_FIXTURE' | 'LIVE_MODEL' | 'MIXED';

export interface Provenance {
  readonly input: { readonly kind: 'SCRIPTED' | 'LIVE'; readonly label: string };
  readonly extraction: { readonly mode: ExtractionMode; readonly provider: string | null; readonly model: string | null };
}

export interface LivePartial {
  readonly utteranceId: string;
  readonly speaker: Speaker;
  /** At most LIVE_CAPTION_MAX characters: the end of what has been said so far. */
  readonly text: string;
}

export interface TransitionRecord {
  readonly event: SessionEvent['type'];
  readonly from: Lifecycle;
  readonly to: Lifecycle;
  readonly at: string;
}

export interface Diagnostics {
  readonly duplicateUtterancesIgnored: number;
  readonly invalidUtterancesIgnored: number;
  readonly duplicateExtractionsIgnored: number;
  readonly extractionRetries: number;
  readonly backendReachable: boolean | null;
}

export interface FailedBatch {
  readonly utteranceIds: readonly string[];
  readonly error: string;
}

export interface SessionSnapshot {
  readonly session: SessionState;
  readonly context: ConsultationState;
  /** Final utterances in order. Held in memory only, and not meant to be shown in full. */
  readonly utterances: readonly Utterance[];
  readonly livePartial: LivePartial | null;
  readonly provenance: Provenance;
  /** Mandatory status lines. Always shown whenever the session is shown. */
  readonly banner: readonly string[];
  readonly pendingBatches: number;
  readonly failedBatches: readonly FailedBatch[];
  readonly transitions: readonly TransitionRecord[];
  readonly diagnostics: Diagnostics;
}

export type SessionListener = (snapshot: SessionSnapshot) => void;
export type AssignError = 'NOT_ACTIVE' | 'UNKNOWN_UTTERANCE' | 'NOT_UNATTRIBUTED' | 'ALREADY_QUEUED' | 'INVALID_SPEAKER';

export interface SessionOptions {
  /** Utterances sent as read-only context before a batch. */
  readonly contextWindow?: number;
  /** After a doctor/patient exchange goes quiet, extract what is pending. */
  readonly quietFlushMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
}

export interface SessionDeps {
  readonly consultationId: string;
  readonly provider: TranscriptionProvider;
  readonly extraction: ExtractionClient;
  readonly scheduler: Scheduler;
  readonly now: () => string;
  readonly options?: SessionOptions;
}

export const LIVE_CAPTION_MAX = 60;

const INPUT_LABEL = {
  SCRIPTED: 'SCRIPTED CONSULTATION: synthetic script, not a real patient and not a live microphone',
  LIVE: 'LIVE MICROPHONE',
} as const;

export function bannerFor(p: Provenance): string[] {
  const lines: string[] = [p.input.label];
  switch (p.extraction.mode) {
    case 'REPLAY_FIXTURE':
      lines.push('EXTRACTION: RECORDED REPLAY. These results are not from a live model.');
      break;
    case 'LIVE_MODEL':
      lines.push(`EXTRACTION: LIVE MODEL (${p.extraction.provider ?? 'unknown'} ${p.extraction.model ?? ''})`.trim());
      break;
    case 'MIXED':
      lines.push('EXTRACTION: MIXED. Some results are a recorded replay and some are from a live model.');
      break;
    default:
      lines.push('EXTRACTION: backend not contacted yet');
  }
  return lines;
}

interface QueueItem {
  readonly kind: 'NORMAL' | 'REEXTRACT';
  readonly utteranceIds: readonly string[];
  attempt: number;
}

// ---------------------------------------------------------------------------------------------- the session
export class ConsultationSession {
  private readonly provider: TranscriptionProvider;
  private readonly client: ExtractionClient;
  private readonly scheduler: Scheduler;
  private readonly now: () => string;
  private readonly consultationId: string;
  private readonly opts: Required<SessionOptions>;

  private state: SessionState = createSession();
  private context: ConsultationState;
  private utterances: Utterance[] = [];
  private seenUtteranceIds = new Set<string>();
  private pending: string[] = [];
  private queue: QueueItem[] = [];
  private failed: FailedBatch[] = [];
  private current: QueueItem | null = null;
  private pumping = false;
  private quietCancel: Cancel | null = null;
  private livePartial: LivePartial | null = null;
  private transitions: TransitionRecord[] = [];
  private observedReplay = false;
  private observedLive = false;
  private declared: BackendHealth['extraction_provider'] | null = null;
  private observedProvider: string | null = null;
  private observedModel: string | null = null;
  private diag = { duplicateUtterancesIgnored: 0, invalidUtterancesIgnored: 0, duplicateExtractionsIgnored: 0, extractionRetries: 0, backendReachable: null as boolean | null };
  private listeners = new Set<SessionListener>();
  private idleWaiters: Array<() => void> = [];
  private unsubscribeProvider: () => void;
  private snapshot: SessionSnapshot;

  constructor(deps: SessionDeps) {
    this.provider = deps.provider;
    this.client = deps.extraction;
    this.scheduler = deps.scheduler;
    this.now = deps.now;
    this.consultationId = deps.consultationId;
    this.opts = { contextWindow: 6, quietFlushMs: 3000, maxAttempts: 3, retryBaseDelayMs: 1000, ...deps.options };
    this.context = createConsultation(deps.consultationId);
    this.unsubscribeProvider = this.provider.subscribe((e) => this.onProviderEvent(e));
    this.snapshot = this.buildSnapshot();
  }

  // ------------------------------------------------------------------------------------------ reading
  getSnapshot(): SessionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when nothing is pending, queued or in flight. */
  whenIdle(): Promise<void> {
    return this.isIdle() ? Promise.resolve() : new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  dispose(): void {
    this.unsubscribeProvider();
    this.quietCancel?.();
    this.provider.stop();
  }

  // ------------------------------------------------------------------------------------------ lifecycle
  async start(): Promise<TransitionResult> {
    const started = this.dispatch({ type: 'START' });
    if (started.error) return started;
    try {
      const health = await this.client.health();
      this.declared = health.extraction_provider;
      this.diag.backendReachable = true;
    } catch {
      this.diag.backendReachable = false;
    }
    this.commit();
    try {
      await this.provider.start();
    } catch (e) {
      this.dispatch({ type: 'PROVIDER_FAILED', reason: e instanceof Error ? e.message : 'provider failed to start', fatal: true });
    }
    return started;
  }

  pause(): TransitionResult {
    const r = this.dispatch({ type: 'PAUSE' });
    if (!r.error) this.provider.pause();
    return r;
  }

  resume(): TransitionResult {
    const r = this.dispatch({ type: 'RESUME' });
    if (!r.error) this.provider.resume();
    return r;
  }

  /** Stop listening, extract what is pending, then end. Queued extraction still drains afterwards. */
  end(): TransitionResult {
    if (!canTransition(this.state, { type: 'END' })) return this.dispatch({ type: 'END' });
    this.provider.stop();
    this.livePartial = null;
    this.flushPending();
    return this.dispatch({ type: 'END' });
  }

  // ------------------------------------------------------------------------------------------ speaker review
  /**
   * The doctor assigns a speaker to an unattributed utterance. If it has not been sent for extraction yet, its speaker
   * is simply updated. If it has already been extracted (and so held), it is re-extracted.
   */
  assignSpeaker(utteranceId: string, speaker: 'DOCTOR' | 'PATIENT'): AssignError | null {
    if (speaker !== 'DOCTOR' && speaker !== 'PATIENT') return 'INVALID_SPEAKER';
    if (this.state.lifecycle === 'IDLE' || this.state.lifecycle === 'STARTING') return 'NOT_ACTIVE';
    const i = this.utterances.findIndex((u) => u.id === utteranceId);
    if (i < 0) return 'UNKNOWN_UTTERANCE';
    const u = this.utterances[i]!;
    if (u.speaker !== 'UNATTRIBUTED') return 'NOT_UNATTRIBUTED';
    if (this.queue.some((q) => q.kind === 'REEXTRACT' && q.utteranceIds[0] === utteranceId)) return 'ALREADY_QUEUED';
    this.utterances = this.utterances.map((x, idx) => (idx === i ? { ...u, speaker, speaker_basis: 'MANUAL_SELECTION' as const } : x));
    const notSentYet = this.pending.includes(utteranceId) || this.queue.some((q) => q !== this.current && q.kind === 'NORMAL' && q.utteranceIds.includes(utteranceId));
    if (!notSentYet) {
      this.queue.push({ kind: 'REEXTRACT', utteranceIds: [utteranceId], attempt: 0 });
      void this.pump();
    }
    this.commit();
    return null;
  }

  // ------------------------------------------------------------------------------------------ doctor review
  confirm(id: string): ActionError | null {
    return this.act((s) => confirmObservation(s, id, this.now()));
  }
  correct(id: string, patch: CorrectionPatch): ActionError | null {
    return this.act((s) => correctObservation(s, id, patch, this.now()));
  }
  reject(id: string, note?: string): ActionError | null {
    return this.act((s) => rejectObservation(s, id, this.now(), note));
  }
  annotate(id: string, note: string): ActionError | null {
    return this.act((s) => annotateObservation(s, id, note, this.now()));
  }
  resolveConflict(keepId: string): ActionError | null {
    return this.act((s) => resolveConflict(s, keepId, this.now()));
  }

  private act(fn: (s: ConsultationState) => { state: ConsultationState; error: ActionError | null }): ActionError | null {
    const r = fn(this.context);
    if (!r.error && r.state !== this.context) {
      this.context = r.state;
      this.commit();
    }
    return r.error;
  }

  // ------------------------------------------------------------------------------------------ speech region (used by Milestone 8)
  speechStarted(): TransitionResult {
    return this.dispatch({ type: 'SPEECH_STARTED' });
  }
  speechEnded(): TransitionResult {
    return this.dispatch({ type: 'SPEECH_ENDED' });
  }
  speechInterrupted(): TransitionResult {
    return this.dispatch({ type: 'SPEECH_INTERRUPTED' });
  }

  /** Re-send batches that failed permanently. Safe to repeat: nothing is applied twice. */
  retryFailed(): number {
    const items = this.failed.splice(0);
    for (const f of items) this.queue.push({ kind: 'NORMAL', utteranceIds: f.utteranceIds, attempt: 0 });
    if (items.length > 0) {
      this.commit();
      void this.pump();
    }
    return items.length;
  }

  // ------------------------------------------------------------------------------------------ provider events
  private onProviderEvent(e: ProviderEvent): void {
    switch (e.type) {
      case 'started':
        this.dispatch({ type: 'PROVIDER_STARTED' });
        return;
      case 'partial': {
        if (this.state.lifecycle !== 'LISTENING') return;
        const text = e.text.length > LIVE_CAPTION_MAX ? e.text.slice(-LIVE_CAPTION_MAX) : e.text;
        this.livePartial = { utteranceId: e.utteranceId, speaker: e.speaker, text };
        // someone is still speaking: the quiet window restarts, so a question and its answer stay in one batch
        if (this.pending.length > 0) this.armQuietFlush();
        this.commit();
        return;
      }
      case 'final':
        this.onFinal(e.utterance);
        return;
      case 'exhausted':
        this.dispatch({ type: 'INPUT_EXHAUSTED' });
        this.flushPending();
        return;
      case 'error':
        this.dispatch({ type: 'PROVIDER_FAILED', reason: e.reason, fatal: e.fatal });
        return;
    }
  }

  private onFinal(raw: Utterance): void {
    // finals are accepted while listening or paused (one may already be in flight when pause is pressed), never otherwise
    if (this.state.lifecycle !== 'LISTENING' && this.state.lifecycle !== 'PAUSED') return;
    const parsed = UtteranceSchema.safeParse(raw);
    if (!parsed.success) {
      this.diag.invalidUtterancesIgnored += 1;
      this.commit();
      return;
    }
    const u = parsed.data;
    if (this.seenUtteranceIds.has(u.id)) {
      this.diag.duplicateUtterancesIgnored += 1; // a repeated event can never create a second extraction
      this.commit();
      return;
    }
    this.seenUtteranceIds.add(u.id);
    this.utterances = [...this.utterances, u];
    this.pending.push(u.id);
    if (this.livePartial?.utteranceId === u.id) this.livePartial = null;
    // An answer completes an exchange: extract it now. Anything else waits for the answer or a quiet period.
    if (u.speaker === 'PATIENT') this.flushPending();
    else this.armQuietFlush();
    this.commit();
  }

  private armQuietFlush(): void {
    this.quietCancel?.();
    this.quietCancel = this.scheduler.schedule(this.opts.quietFlushMs, () => {
      this.quietCancel = null;
      this.flushPending();
    });
  }

  private flushPending(): void {
    this.quietCancel?.();
    this.quietCancel = null;
    if (this.pending.length > 0) {
      this.queue.push({ kind: 'NORMAL', utteranceIds: this.pending, attempt: 0 });
      this.pending = [];
      this.commit();
    }
    void this.pump();
  }

  // ------------------------------------------------------------------------------------------ extraction
  private buildRequest(item: QueueItem): ExtractRequest {
    const batch = item.utteranceIds.map((id) => this.utterances.find((u) => u.id === id)!).filter(Boolean);
    const firstIndex = this.utterances.findIndex((u) => u.id === batch[0]!.id);
    const inBatch = new Set(item.utteranceIds);
    const context = this.utterances.slice(Math.max(0, firstIndex - this.opts.contextWindow), firstIndex).filter((u) => !inBatch.has(u.id));
    return {
      schema_version: '1.0',
      consultation_id: this.consultationId,
      data_classification: 'SYNTHETIC',
      utterances: batch,
      context_utterances: context,
      known_observations: knownRefs(this.context),
    };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0]!;
        if (this.dispatch({ type: 'EXTRACTION_STARTED' }).error) break; // cannot extract yet; retried on the next flush
        this.current = item;
        let response: ExtractResponse | null = null;
        let error: ExtractionError | null = null;
        try {
          response = await this.client.extract(this.buildRequest(item));
        } catch (e) {
          error = e instanceof ExtractionError ? e : new ExtractionError('unexpected_error', 'Extraction failed unexpectedly.', false);
        }
        this.current = null;
        if (response) {
          this.applyResponse(item, response);
          this.dispatch({ type: 'EXTRACTION_SUCCEEDED' });
          this.queue.shift();
        } else if (error) {
          this.dispatch({ type: 'EXTRACTION_FAILED', error: error.code });
          if (error.retriable && item.attempt + 1 < this.opts.maxAttempts) {
            item.attempt += 1;
            this.diag.extractionRetries += 1;
            this.commit();
            // hold the queue while waiting, so batches are never applied out of order
            await new Promise<void>((resolve) => {
              this.scheduler.schedule(this.opts.retryBaseDelayMs * 2 ** (item.attempt - 1), resolve);
            });
          } else {
            this.queue.shift();
            this.failed.push({ utteranceIds: item.utteranceIds, error: error.code });
          }
        }
        this.commit();
      }
    } finally {
      this.pumping = false;
      this.commit();
      this.notifyIdle();
    }
  }

  private applyResponse(item: QueueItem, response: ExtractResponse): void {
    if (this.context.appliedExtractions.includes(response.extraction_id)) {
      this.diag.duplicateExtractionsIgnored += 1;
      return;
    }
    this.context = applyExtraction(this.context, response, this.now());
    if (item.kind === 'REEXTRACT') this.context = clearHeld(this.context, item.utteranceIds[0]!, this.now());
    if (response.extractor.is_replay) this.observedReplay = true;
    else this.observedLive = true;
    this.observedProvider = response.extractor.provider;
    this.observedModel = response.extractor.model;
  }

  // ------------------------------------------------------------------------------------------ plumbing
  private dispatch(event: SessionEvent): TransitionResult {
    const r = transition(this.state, event);
    if (r.error) return r;
    if (r.changed) {
      if (r.state.lifecycle !== this.state.lifecycle) {
        this.transitions = [...this.transitions, { event: event.type, from: this.state.lifecycle, to: r.state.lifecycle, at: this.now() }];
      }
      this.state = r.state;
      this.commit();
    }
    return r;
  }

  private isIdle(): boolean {
    return !this.pumping && this.queue.length === 0 && this.pending.length === 0;
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters.splice(0);
    for (const w of waiters) w();
  }

  private provenance(): Provenance {
    const input = this.provider.capabilities.live
      ? { kind: 'LIVE' as const, label: INPUT_LABEL.LIVE }
      : { kind: 'SCRIPTED' as const, label: INPUT_LABEL.SCRIPTED };
    let mode: ExtractionMode = 'NOT_CONTACTED';
    if (this.observedReplay && this.observedLive) mode = 'MIXED';
    else if (this.observedReplay) mode = 'REPLAY_FIXTURE';
    else if (this.observedLive) mode = 'LIVE_MODEL';
    else if (this.declared === 'replay') mode = 'REPLAY_FIXTURE';
    else if (this.declared === 'gemini') mode = 'LIVE_MODEL';
    return { input, extraction: { mode, provider: this.observedProvider ?? this.declared, model: this.observedModel } };
  }

  private buildSnapshot(): SessionSnapshot {
    const provenance = this.provenance();
    return {
      session: this.state,
      context: this.context,
      utterances: this.utterances,
      livePartial: this.livePartial,
      provenance,
      banner: bannerFor(provenance),
      pendingBatches: this.queue.length + (this.pending.length > 0 ? 1 : 0),
      failedBatches: [...this.failed],
      transitions: this.transitions,
      diagnostics: { ...this.diag },
    };
  }

  private commit(): void {
    this.snapshot = this.buildSnapshot();
    for (const l of [...this.listeners]) l(this.snapshot);
  }
}
