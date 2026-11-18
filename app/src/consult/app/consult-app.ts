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
import { deriveBeads, deriveCard, deriveControls, type BackendResolution, type BeadModel, type CaptionState, type CardModel, type ControlsModel, type ExtractionSource, type ReviewPanel, type XrayMode } from '../ui/consult-view-model.js';

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
  /** Name of an active controlled test fixture, shown on the controls. Null in normal use. */
  readonly testFixture?: string | null;
}

/** The caption holds a finished line briefly, then dims, then goes. */
export const CAPTION_FADE_AFTER_MS = 1500;
export const CAPTION_CLEAR_AFTER_MS = 3200;
export const CAPTION_MAX_CHARS = 60;

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
  private panel: ReviewPanel | null = null;
  private refCondition: string | null = null;
  private xrayMode: XrayMode = 'OFF';
  private caption: CaptionState | null = null;
  private captionTimers: Array<() => void> = [];
  private seenUtterances = 0;

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
      case 'CORRECT_OBSERVATION':
      case 'ANNOTATE_OBSERVATION':
        this.review(intent, source);
        return;
      case 'SET_REVIEW_PANEL':
        if (this.selected) {
          this.panel = intent.panel === this.panel ? null : intent.panel;
          this.refCondition = null;
          this.xrayMode = 'OFF';
          this.commit();
        }
        return;
      case 'SET_XRAY':
        if (this.selected && this.panel === 'REFERENCE') {
          this.xrayMode = intent.mode;
          this.commit();
        }
        return;
      case 'SET_REFERENCE_CONDITION':
        if (this.selected && this.panel === 'REFERENCE') {
          this.refCondition = intent.condition;
          this.xrayMode = 'OFF';
          this.commit();
        }
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
    this.clearCaptionTimers();
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
      this.panel = null;
      this.refCondition = null;
      this.xrayMode = 'OFF';
      this.setCaption(null);
      this.seenUtterances = 0;
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
    this.updateCaption(s);
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

  // ---------------------------------------------------------------------------------------- caption
  private clearCaptionTimers(): void {
    for (const cancel of this.captionTimers) cancel();
    this.captionTimers = [];
  }

  private setCaption(c: CaptionState | null): void {
    this.clearCaptionTimers();
    this.caption = c;
  }

  private static line(speaker: string, text: string): string {
    const who = speaker === 'DOCTOR' ? 'Doctor' : speaker === 'PATIENT' ? 'Patient' : '?';
    const room = CAPTION_MAX_CHARS - who.length - 2;
    return `${who}: ${text.length > room ? text.slice(-room) : text}`;
  }

  /** One line only: the live partial while someone speaks, then the end of the finished utterance, which fades. */
  private updateCaption(s: SessionSnapshot): void {
    if (s.livePartial) {
      this.setCaption({ text: ConsultApp.line(s.livePartial.speaker, s.livePartial.text), fading: false });
      return;
    }
    if (s.utterances.length > this.seenUtterances) {
      this.seenUtterances = s.utterances.length;
      const u = s.utterances[s.utterances.length - 1]!;
      this.setCaption({ text: ConsultApp.line(u.speaker, u.text), fading: false });
      this.captionTimers.push(
        this.deps.scheduler.schedule(CAPTION_FADE_AFTER_MS, () => {
          if (this.caption) { this.caption = { ...this.caption, fading: true }; this.commit(); }
        }),
        this.deps.scheduler.schedule(CAPTION_CLEAR_AFTER_MS, () => {
          this.caption = null;
          this.commit();
        }),
      );
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
    this.panel = null;
    this.refCondition = null;
    this.xrayMode = 'OFF';
    this.commit();
  }

  private review(
    intent: Extract<Intent, { type: 'CONFIRM_OBSERVATION' | 'REJECT_OBSERVATION' | 'RESOLVE_CONFLICT' | 'CORRECT_OBSERVATION' | 'ANNOTATE_OBSERVATION' }>,
    source: IntentSource,
  ): void {
    if (!this.session) return;
    if (!EXPLICIT_SOURCES.has(source)) {
      this.notice = 'Review actions need an explicit press on the card.';
      this.commit();
      return;
    }
    const id = intent.observationId;
    let error: ActionError | null;
    switch (intent.type) {
      case 'CONFIRM_OBSERVATION':
        error = this.session.confirm(id);
        break;
      case 'REJECT_OBSERVATION':
        error = this.session.reject(id);
        break;
      case 'RESOLVE_CONFLICT':
        error = this.session.resolveConflict(id);
        break;
      case 'CORRECT_OBSERVATION':
        error = this.session.correct(id, {
          ...(intent.status ? { status: intent.status } : {}),
          ...(intent.severity ? { attributes: { severity: intent.severity } } : {}),
        });
        break;
      default:
        error = this.session.annotate(id, intent.note);
    }
    this.notice = error ? ACTION_NOTICE[error] : null;
    if (!error) {
      this.panel = null;
      this.refCondition = null;
      this.xrayMode = 'OFF';
    }
    this.commit();
  }

  // ---------------------------------------------------------------------------------------- snapshot
  private build(): AppSnapshot {
    const sessionSnap = this.session?.getSnapshot() ?? null;
    const beads = sessionSnap ? deriveBeads(sessionSnap.context) : [];
    const selected = this.selected && beads.some((b) => b.observationId === this.selected) ? this.selected : null;
    return {
      session: sessionSnap,
      controls: deriveControls(sessionSnap, this.resolution, this.source, this.caption, this.deps.testFixture ?? null),
      beads,
      selectedObservationId: selected,
      card: sessionSnap ? deriveCard(sessionSnap.context, sessionSnap.utterances, selected, this.panel, this.refCondition, this.xrayMode) : null,
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
