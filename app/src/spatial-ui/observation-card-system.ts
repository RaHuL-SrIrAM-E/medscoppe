import {
  BufferAttribute, BufferGeometry, Group, Line, LineBasicMaterial, Vector3, createSystem, type UIKit, type UIKitMLAsset,
} from '@iwsdk/core';
import { AnatomyRoot } from '../anatomy/anatomy-component.js';
import { consultApp } from '../consult/app/consult-singleton.js';
import type { CardModel } from '../consult/ui/consult-view-model.js';
import { intentBus, type IntentSource } from '../core/intents.js';
import { motion } from '../design/tokens.js';
import { beadWorldPosition } from './observation-beads-system.js';

const HIDDEN_Y = -10;
const CARD_OFFSET = 0.45; // metres to the viewer-right of the selected bead
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
    for (const id of ['title', 'presence', 'source', 'confirm', 'duration', 'evidence-label', 'evidence', 'placement', 'notice']) {
      this.els[id] = panel.getElementById<UIKit.Text>(id);
    }
    for (const id of ['obs-btn-confirm', 'obs-btn-resolve', 'obs-btn-reject', 'obs-btn-close']) this.buttons[id] = panel.getElementById(id);
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
    wire('obs-btn-close', () => intentBus.emit({ type: 'CLEAR_OBSERVATION_SELECTION' }, this.source()));
    this.panel = panel;
    panel.position.set(0, HIDDEN_Y, 0);
  }

  private paint(card: CardModel): void {
    const set = (id: string, props: Record<string, unknown>): void => this.els[id]?.setProperties(props);
    const row = (text: string | null) => ({ text: text ?? '', display: text ? 'flex' : 'none' });
    set('title', { text: card.title });
    set('presence', { text: card.presenceLine });
    set('source', { text: card.sourceLine, color: SOURCE_COLOUR[card.origin] });
    set('confirm', { text: card.confirmLine, color: card.confirmed ? '#7cf2d4' : '#ffb454' });
    set('duration', row(card.durationLine));
    set('evidence-label', { text: card.evidenceLabel });
    set('evidence', { text: card.evidenceQuote });
    set('placement', { text: card.placementNote });
    set('notice', row(card.notice));
    this.buttons['obs-btn-confirm']?.setProperties({ display: card.actions.confirm ? 'flex' : 'none' });
    this.buttons['obs-btn-resolve']?.setProperties({ display: card.actions.resolve ? 'flex' : 'none' });
    this.buttons['obs-btn-reject']?.setProperties({ display: card.actions.reject ? 'flex' : 'none' });
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
    this.target.copy(beadPos).addScaledVector(this.right, CARD_OFFSET).addScaledVector(this.forward, -0.04);

    const k = 1 - Math.exp(-motion.smoothing * delta);
    if (this.shownFor !== card.observationId && this.panel.position.y < HIDDEN_Y + 1) this.panel.position.copy(this.target);
    else this.panel.position.lerp(this.target, k);
    this.shownFor = card.observationId;
    this.panel.lookAt(this.head);

    this.edge.copy(this.panel.position).addScaledVector(this.right, -0.2);
    const p = this.linePositions;
    p[0] = beadPos.x; p[1] = beadPos.y; p[2] = beadPos.z;
    p[3] = this.edge.x; p[4] = this.edge.y; p[5] = this.edge.z;
    this.lineGeometry.attributes.position.needsUpdate = true;
  }
}
