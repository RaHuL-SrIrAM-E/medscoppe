import {
  BufferAttribute, BufferGeometry, Group, Line, LineBasicMaterial, Vector3, createSystem, type UIKit, type UIKitMLAsset,
} from '@iwsdk/core';
import { AnatomyRoot } from '../anatomy/anatomy-component.js';
import { consultApp } from '../consult/app/consult-singleton.js';
import type { CardModel } from '../consult/ui/consult-view-model.js';
import { intentBus, type IntentSource } from '../core/intents.js';
import { motion } from '../design/tokens.js';
import { beadLabelReach, beadWorldPosition } from './observation-beads-system.js';

const HIDDEN_Y = -10;
const OPTION_SLOTS = 5;
const CARD_HALF_WIDTH = 0.17;
const MAX_LABEL_CLEARANCE = 0.3; // a very long label may overlap the card edge slightly rather than push the card out of view
const CARD_GAP = 0.04;
const REFERENCE_OFFSET = 0.62; // metres left of the model axis
const BORDER: Record<CardModel['origin'], string> = { PATIENT: '#8ab4ff', DOCTOR_OBSERVED: '#f2c14e', DOCTOR_CONFIRMED: '#7cf2d4' };
const SOURCE_COLOUR = BORDER;

/**
 * ONE contextual card for observations. It is reused for every bead: selecting another bead repaints and moves it. It
 * emits explicit review intents and shows only what the store holds: no confirm action is ever offered for a condition
 * the patient mentioned, and confirmation is never implied.
 */
export class ObservationCardSystem extends createSystem({ roots: { required: [AnatomyRoot] } }) {
  private panel: UIKitMLAsset | null = null;
  private els: Record<string, UIKit.Text | null> = {};
  private buttons: Record<string, ReturnType<UIKitMLAsset['getElementById']>> = {};
  private lastRevision = -1;
  private shownFor: string | null = null;
  private head!: Vector3;
  private bead!: Vector3;
  private right!: Vector3;
  private forward!: Vector3;
  private axis!: Vector3;
  private target!: Vector3;
  private edge!: Vector3;
  private linePositions!: Float32Array;
  private lineGeometry!: BufferGeometry;
  private group!: Group;

  init(): void {
    this.head = new Vector3();
    this.bead = new Vector3();
    this.right = new Vector3();
    this.forward = new Vector3();
    this.axis = new Vector3();
    this.target = new Vector3();
    this.edge = new Vector3();
    this.linePositions = new Float32Array(6);
    this.lineGeometry = new BufferGeometry();
    this.lineGeometry.setAttribute('position', new BufferAttribute(this.linePositions, 3));
    const line = new Line(this.lineGeometry, new LineBasicMaterial({ color: 0x8ab4ff, transparent: true, opacity: 0.8, depthTest: false }));
    line.frustumCulled = false;
    line.renderOrder = 10;
    this.group = new Group();
    this.group.add(line);
    this.group.visible = false;
    this.world.createTransformEntity(this.group);
  }

  private source(): IntentSource {
    return this.renderer.xr.isPresenting ? 'hand' : 'desktop';
  }

  private tryBind(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('observation-card');
    if (!panel) return;
    for (const id of ['obs-btn-close-label', 'obs-btn-ref-label', 'title', 'presence', 'source', 'confirm', 'duration', 'severity', 'revision', 'note', 'evidence-label', 'evidence', 'placement', 'notice', 'ref-tests', 'ref-meds', 'ref-notice']) {
      this.els[id] = panel.getElementById<UIKit.Text>(id);
    }
    for (const id of ['obs-btn-confirm', 'obs-btn-resolve', 'obs-btn-reject', 'obs-btn-close', 'obs-btn-correct', 'obs-btn-note', 'obs-btn-ref']) this.buttons[id] = panel.getElementById(id);
    const wire = (id: string, handler: () => void): void => {
      const el = this.buttons[id];
      if (!el) return;
      el.addEventListener('click', handler);
      this.cleanupFuncs.push(() => el.removeEventListener('click', handler));
    };
    const current = (): string | null => consultApp.getSnapshot().selectedObservationId;
    wire('obs-btn-confirm', () => { const id = current(); if (id) intentBus.emit({ type: 'CONFIRM_OBSERVATION', observationId: id }, this.source()); });
    wire('obs-btn-resolve', () => { const id = current(); if (id) intentBus.emit({ type: 'RESOLVE_CONFLICT', observationId: id }, this.source()); });
    wire('obs-btn-reject', () => { const id = current(); if (id) intentBus.emit({ type: 'REJECT_OBSERVATION', observationId: id }, this.source()); });
    wire('obs-btn-correct', () => intentBus.emit({ type: 'SET_REVIEW_PANEL', panel: 'CORRECT' }, this.source()));
    wire('obs-btn-ref', () => intentBus.emit({ type: 'SET_REVIEW_PANEL', panel: 'REFERENCE' }, this.source()));
    wire('obs-btn-note', () => intentBus.emit({ type: 'SET_REVIEW_PANEL', panel: 'NOTE' }, this.source()));
    wire('obs-btn-close', () => {
      // while a review row is open this is "Back": it closes the row; otherwise it closes the card
      const c = consultApp.getSnapshot().card;
      const open = c?.panel;
      if (c?.reference?.backToList) { intentBus.emit({ type: 'SET_REFERENCE_CONDITION', condition: null }, this.source()); return; }
      intentBus.emit(open ? { type: 'SET_REVIEW_PANEL', panel: open } : { type: 'CLEAR_OBSERVATION_SELECTION' }, this.source());
    });
    for (let i = 0; i < OPTION_SLOTS; i++) {
      this.buttons[`obs-opt-${i}`] = panel.getElementById(`obs-opt-${i}`);
      this.els[`obs-opt-${i}-label`] = panel.getElementById<UIKit.Text>(`obs-opt-${i}-label`);
      // the intent comes from the card model (ConsultApp decides what each option does); the UI holds no review rules
      wire(`obs-opt-${i}`, () => { const o = consultApp.getSnapshot().card?.options[i]; if (o) intentBus.emit(o.intent, this.source()); });
    }
    this.panel = panel;
    panel.position.set(0, HIDDEN_Y, 0);
  }

  private paint(card: CardModel): void {
    const set = (id: string, props: Record<string, unknown>): void => this.els[id]?.setProperties(props);
    const row = (text: string | null) => ({ text: text ?? '', display: text ? 'flex' : 'none' });
    const showingRef = card.panel === 'REFERENCE' && card.reference !== null;
    const choosing = card.panel !== null && !showingRef;
    // the reference view drops the review fields so the lists fit on one small card
    const compact = choosing || showingRef;
    // while a review row is open the card shrinks to the title, the choices and Back: the evidence stays one press away
    const hide = { display: 'none' };
    set('title', { text: card.title });
    set('presence', { text: showingRef ? card.reference!.heading : choosing ? (card.panel === 'CORRECT' ? 'Correct: choose one' : 'Add a short note: choose one') : card.presenceLine });
    set('source', compact ? hide : { text: card.sourceLine, color: SOURCE_COLOUR[card.origin], display: 'flex' });
    set('confirm', compact ? hide : { text: card.confirmLine, color: card.confirmed ? '#7cf2d4' : '#ffb454', display: 'flex' });
    set('duration', compact ? hide : row(card.durationLine));
    set('severity', compact ? hide : row(card.severityLine));
    set('revision', compact ? hide : row(card.revisionLine));
    set('note', compact ? hide : row(card.noteLine));
    set('evidence-label', compact ? hide : { text: card.evidenceLabel, display: 'flex' });
    set('evidence', compact ? hide : { text: card.evidenceQuote, display: 'flex' });
    set('placement', compact ? hide : { text: card.placementNote, display: 'flex' });
    set('notice', compact ? hide : row(card.notice));
    set('ref-tests', showingRef ? { text: card.reference!.testsLine, display: 'flex' } : hide);
    set('ref-meds', showingRef && card.reference!.medicinesLine ? { text: card.reference!.medicinesLine, display: 'flex' } : hide);
    set('ref-notice', showingRef ? { text: card.reference!.notice, display: 'flex' } : hide);
    set('obs-btn-ref-label', { text: card.referenceLabel });
    set('obs-btn-close-label', { text: choosing || showingRef ? 'Back' : 'Close' });
    this.buttons['obs-btn-confirm']?.setProperties({ display: card.actions.confirm && !compact ? 'flex' : 'none' });
    this.buttons['obs-btn-resolve']?.setProperties({ display: card.actions.resolve && !compact ? 'flex' : 'none' });
    this.buttons['obs-btn-reject']?.setProperties({ display: card.actions.reject && !compact ? 'flex' : 'none' });
    this.buttons['obs-btn-correct']?.setProperties({ display: card.actions.correct && !compact ? 'flex' : 'none' });
    this.buttons['obs-btn-ref']?.setProperties({ display: card.actions.reference && !compact && !showingRef ? 'flex' : 'none' });
    this.buttons['obs-btn-note']?.setProperties({ display: card.actions.annotate && !compact ? 'flex' : 'none' });
    for (let i = 0; i < OPTION_SLOTS; i++) {
      const opt = card.options[i];
      this.buttons[`obs-opt-${i}`]?.setProperties({ display: opt ? 'flex' : 'none' });
      if (opt) this.els[`obs-opt-${i}-label`]?.setProperties({ text: opt.label });
    }
    this.panel?.getElementById('card')?.setProperties({ borderColor: BORDER[card.origin] });
  }

  update(delta: number): void {
    if (!this.panel) {
      this.tryBind();
      return;
    }
    const snap = consultApp.getSnapshot();
    const card = snap.card;
    if (snap.revision !== this.lastRevision) {
      this.lastRevision = snap.revision;
      if (card) this.paint(card);
    }
    const root = this.queries.roots.entities.values().next().value;
    const rootObject = root?.object3D;
    const beadPos = card && rootObject ? beadWorldPosition(card.observationId, this.bead) : null;
    this.group.visible = !!(card && beadPos);
    if (!card || !beadPos || !rootObject) {
      this.shownFor = null;
      this.panel.position.y += (HIDDEN_Y - this.panel.position.y) * 0.5;
      if (this.panel.position.y < HIDDEN_Y + 1) this.panel.position.y = HIDDEN_Y;
      return;
    }
    rootObject.getWorldPosition(this.axis);
    this.player.head.getWorldPosition(this.head);
    this.forward.set(this.axis.x - this.head.x, 0, this.axis.z - this.head.z).normalize();
    this.right.set(-this.forward.z, 0, this.forward.x);
    // the tests and medicines view is tall, so it sits to the LEFT of the body at chest height, where nothing else floats
    const side = card.panel === 'REFERENCE' ? -1 : 1;
    if (side < 0) this.target.copy(this.axis).addScaledVector(this.right, -REFERENCE_OFFSET).addScaledVector(this.forward, -0.04);
    else this.target.copy(beadPos).addScaledVector(this.right, Math.min(beadLabelReach(card.observationId) * 1.12, MAX_LABEL_CLEARANCE) + CARD_GAP + CARD_HALF_WIDTH).addScaledVector(this.forward, -0.04);
    this.target.y -= side < 0 ? 0.05 : 0.12; // sit a little below the bead so a tall card stays inside the view

    const k = 1 - Math.exp(-motion.smoothing * delta);
    if (this.shownFor !== card.observationId && this.panel.position.y < HIDDEN_Y + 1) this.panel.position.copy(this.target);
    else this.panel.position.lerp(this.target, k);
    this.shownFor = card.observationId;
    this.panel.lookAt(this.head);

    this.edge.copy(this.panel.position).addScaledVector(this.right, -0.2 * side);
    this.edge.y += 0.1; // end near the title so the line does not cross the text
    const p = this.linePositions;
    p[0] = beadPos.x; p[1] = beadPos.y; p[2] = beadPos.z;
    p[3] = this.edge.x; p[4] = this.edge.y; p[5] = this.edge.z;
    this.lineGeometry.attributes.position.needsUpdate = true;
  }
}
