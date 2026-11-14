/**
 * ConsultApp: the integration layer between the application (intent bus, spatial systems) and the existing consultation
 * session. It owns ONE ConsultationSession at a time, creates a fresh one for every run (an ended session is terminal),
 * keeps the UI-only selection state, and derives everything the spatial UI paints. It contains no consultation logic of
 * its own: lifecycle, extraction, deduplication and the append-only store all live in ConsultationSession.
 *
 * Pure TypeScript (no Three.js, no DOM) so it is tested with virtual time.
 */
import type { Intent, IntentSource } from '../../core/intents.js';
import type { ActionError } from '../context/context-store.js';
import type { Scheduler } from '../core/scheduler.js';
import type { ExtractionClient } from '../extraction/extraction-client.js';
import { ConsultationSession, type SessionSnapshot } from '../session/consultation-session.js';
import type { TranscriptionProvider } from '../transcription/transcription-provider.js';
import { deriveBeads, deriveCard, deriveControls, type BackendResolution, type BeadModel, type CardModel, type ControlsModel, type ExtractionSource } from '../ui/consult-view-model.js';

export interface ExtractionResolution {
  readonly client: ExtractionClient;
  readonly source: ExtractionSource;
  readonly backend: BackendResolution['state'];
}

export interface ConsultAppDeps {
  readonly consultationId: string;
  readonly scheduler: Scheduler;
  readonly now: () => string;
  /** A new provider per run: a finished scripted provider cannot be restarted. */
  readonly createProvider: () => TranscriptionProvider;
  /** Chooses the backend when it is reachable, otherwise the labelled offline replay. Called at load and at every start. */
  readonly resolveExtraction: () => Promise<ExtractionResolution>;
  /** Lets the app clear the anatomy selection so only one card is open at a time. */
  readonly emit: (intent: Intent, source: IntentSource) => void;
}

export interface AppSnapshot {
  readonly session: SessionSnapshot | null;
  readonly controls: ControlsModel;
  readonly beads: readonly BeadModel[];
  readonly selectedObservationId: string | null;
  readonly card: CardModel | null;
  /** The last thing that was refused or failed, for one quiet line. Cleared by the next accepted action. */
  readonly notice: string | null;
  readonly extractionSource: ExtractionSource | null;
  /** Increments on every change, so painters can cheaply tell whether anything moved. */
  readonly revision: number;
}

export type AppListener = (snapshot: AppSnapshot) => void;

const ACTION_NOTICE: Record<ActionError, string> = {
  UNKNOWN_OBSERVATION: 'That observation no longer exists.',
  ALREADY_REJECTED: 'That observation was already dismissed.',
  RESOLVE_CONFLICT_FIRST: 'Resolve the conflict first.',
  CONDITION_NOT_CONFIRMABLE: 'A condition the patient mentioned cannot be confirmed.',
  NO_CHANGE: 'Nothing to change.',
  INVALID_PATCH: 'That change is not valid.',
  NOT_IN_CONFLICT: 'That observation is not in a conflict.',
};

/** Only a deliberate press on a hand or desktop control may confirm anything. Never a voice, script or inferred source. */
const EXPLICIT_SOURCES: ReadonlySet<IntentSource> = new Set<IntentSource>(['hand', 'desktop']);

export class ConsultApp {
  private session: ConsultationSession | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private selected: string | null = null;
  private notice: string | null = null;
  private resolution: BackendResolution = { state: 'UNKNOWN' };
  private source: ExtractionSource | null = null;
  private starting = false;
  private autoEnding = false;
  private runs = 0;
  private rev = 0;
  private listeners = new Set<AppListener>();
  private snapshot: AppSnapshot;
  private emitting = false;

  constructor(private readonly deps: ConsultAppDeps) {
    this.snapshot = this.build();
  }

  getSnapshot(): AppSnapshot {
    return this.snapshot;
  }

  subscribe(listener: AppListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** How many sessions this app has started. Useful for tests of repeated cycles. */
  get runCount(): number {
    return this.runs;
  }

  /** Probe the backend once so the label is truthful before the first start. */
  async prepare(): Promise<void> {
    try {
      const r = await this.deps.resolveExtraction();
      this.resolution = { state: r.backend };
    } catch {
      this.resolution = { state: 'UNREACHABLE' };
    }
    this.commit();
  }

  /** The single entry point for application intents. Unknown intents are ignored. */
  handle(intent: Intent, source: IntentSource): void {
    if (this.emitting) return; // intents this app emitted itself
    switch (intent.type) {
      case 'START_CONSULTATION':
        void this.startNewRun();
        return;
      case 'PAUSE_LISTENING':
        this.lifecycle((s) => s.pause());
        return;
      case 'RESUME_LISTENING':
        this.lifecycle((s) => s.resume());
        return;
      case 'END_CONSULTATION':
        this.lifecycle((s) => s.end());
        return;
      case 'RETRY_EXTRACTION':
        this.session?.retryFailed();
        this.notice = null;
        this.commit();
        return;
      case 'SELECT_OBSERVATION':
        this.selectObservation(intent.observationId, source);
        return;
      case 'CLEAR_OBSERVATION_SELECTION':
        this.setSelected(null);
        return;
      case 'CONFIRM_OBSERVATION':
      case 'REJECT_OBSERVATION':
      case 'RESOLVE_CONFLICT':
        this.review(intent, source);
        return;
      case 'SELECT_STRUCTURE':
      case 'SHOW_CLINICAL_INFORMATION':
        this.setSelected(null); // one contextual card at a time
        return;
      default:
        return;
    }
  }

  dispose(): void {
    this.unsubscribeSession?.();
    this.session?.dispose();
    this.session = null;
  }

  // ---------------------------------------------------------------------------------------- lifecycle
  private lifecycle(fn: (s: ConsultationSession) => { error: unknown }): void {
    if (!this.session) return;
    const r = fn(this.session);
    this.notice = r.error ? 'That is not available right now.' : null;
    this.commit();
  }

  private async startNewRun(): Promise<void> {
    if (this.starting) return; // a repeated press while starting must not create a second session
    const lc = this.session?.getSnapshot().session.lifecycle;
    if (this.session && lc !== 'ENDED' && lc !== 'FAILED') return; // already running: ignore, never reuse
    this.starting = true;
    try {
      const resolved = await this.resolveSafely();
      this.unsubscribeSession?.();
      this.session?.dispose();
      this.runs += 1;
      this.selected = null;
      this.notice = null;
      this.autoEnding = false;
      this.source = resolved.source;
      this.resolution = { state: resolved.backend };
      const session = new ConsultationSession({
        consultationId: `${this.deps.consultationId}-run${this.runs}`,
        provider: this.deps.createProvider(),
        extraction: resolved.client,
        scheduler: this.deps.scheduler,
        now: this.deps.now,
      });
      this.session = session;
      this.unsubscribeSession = session.subscribe((s) => this.onSession(s));
      this.commit();
      await session.start();
    } finally {
      this.starting = false;
      this.commit();
    }
  }

  private async resolveSafely(): Promise<ExtractionResolution> {
    try {
      return await this.deps.resolveExtraction();
    } catch {
      throw new Error('Extraction could not be resolved');
    }
  }

  private onSession(s: SessionSnapshot): void {
    if (this.selected && !s.context.order.includes(this.selected)) this.selected = null;
    this.commit();
    // The script is finite: when it has delivered everything and extraction has drained, the run is complete.
    if (s.session.inputExhausted && s.session.lifecycle === 'LISTENING' && !this.autoEnding) {
      this.autoEnding = true;
      const session = this.session;
      void session?.whenIdle().then(() => {
        if (this.session === session && session?.getSnapshot().session.lifecycle === 'LISTENING') session.end();
      });
    }
  }

  // ---------------------------------------------------------------------------------------- selection and review
  private selectObservation(id: string, source: IntentSource): void {
    const visible = this.snapshot.beads.some((b) => b.observationId === id);
    if (!visible) return;
    const next = this.selected === id ? null : id;
    if (next) {
      // opening an observation card closes the anatomy info card, through the normal intent path
      this.emitting = true;
      try {
        this.deps.emit({ type: 'CLEAR_SELECTION' }, source);
      } finally {
        this.emitting = false;
      }
    }
    this.setSelected(next);
  }

  private setSelected(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.commit();
  }

  private review(intent: Extract<Intent, { type: 'CONFIRM_OBSERVATION' | 'REJECT_OBSERVATION' | 'RESOLVE_CONFLICT' }>, source: IntentSource): void {
    if (!this.session) return;
    if (!EXPLICIT_SOURCES.has(source)) {
      this.notice = 'Review actions need an explicit press on the card.';
      this.commit();
      return;
    }
    const id = intent.observationId;
    const error =
      intent.type === 'CONFIRM_OBSERVATION' ? this.session.confirm(id) : intent.type === 'REJECT_OBSERVATION' ? this.session.reject(id) : this.session.resolveConflict(id);
    this.notice = error ? ACTION_NOTICE[error] : null;
    this.commit();
  }

  // ---------------------------------------------------------------------------------------- snapshot
  private build(): AppSnapshot {
    const sessionSnap = this.session?.getSnapshot() ?? null;
    const beads = sessionSnap ? deriveBeads(sessionSnap.context) : [];
    const selected = this.selected && beads.some((b) => b.observationId === this.selected) ? this.selected : null;
    return {
      session: sessionSnap,
      controls: deriveControls(sessionSnap, this.resolution, this.source),
      beads,
      selectedObservationId: selected,
      card: sessionSnap ? deriveCard(sessionSnap.context, sessionSnap.utterances, selected) : null,
      notice: this.notice,
      extractionSource: this.source,
      revision: ++this.rev,
    };
  }

  private commit(): void {
    this.snapshot = this.build();
    for (const l of [...this.listeners]) l(this.snapshot);
  }
}
