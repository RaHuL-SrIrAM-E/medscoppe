import {
  BufferAttribute, BufferGeometry, CanvasTexture, Group, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, OctahedronGeometry,
  RayInteractable, SRGBColorSpace, SphereGeometry, Sprite, SpriteMaterial, TorusGeometry, Vector3, createSystem,
} from '@iwsdk/core';
import { AnatomyRoot } from '../anatomy/anatomy-component.js';
import { anatomyStore } from '../anatomy/anatomy-state.js';
import { consultApp } from '../consult/app/consult-singleton.js';
import type { BeadModel, Origin } from '../consult/ui/consult-view-model.js';
import { intentBus, type IntentSource } from '../core/intents.js';
import { motion } from '../design/tokens.js';

/** Colour by origin. Not alarm colours: nothing here says "bad", and no colour means "diagnosis". */
const ORIGIN_COLOUR: Record<Origin, number> = { PATIENT: 0x8ab4ff, DOCTOR_OBSERVED: 0xf2c14e, DOCTOR_CONFIRMED: 0x7cf2d4 };
const UNRESOLVED_COLOUR = 0xff9f43;
const MAX_BEADS = 10;
const CORE_R = 0.028;
const HIT_R = 0.045; // 90 mm across: comfortably above the 64 mm hand-target guidance
const ROW = 0.115;
const COLUMN_X = 0.30; // metres to the viewer-right of the model axis
const LABEL_H = 0.056;

// Live world positions, read by the observation card so it can sit beside the selected bead.
const livePositions = new Map<string, Vector3>();
export function beadWorldPosition(observationId: string, out: Vector3): Vector3 | null {
  const p = livePositions.get(observationId);
  return p ? out.copy(p) : null;
}

// How far a bead's label reaches to the right of the bead centre (metres, unscaled), so the card can clear it.
const labelReach = new Map<string, number>();
export function beadLabelReach(observationId: string): number {
  return labelReach.get(observationId) ?? 0.2;
}

interface LabelTexture { texture: CanvasTexture; aspect: number }
const labelCache = new Map<string, LabelTexture>();

function labelTexture(text: string, origin: Origin): LabelTexture {
  const key = `${origin}|${text}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const scale = 2;
  const font = `600 ${22 * scale}px Inter, system-ui, -apple-system, sans-serif`;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const textW = Math.ceil(measure.measureText(text).width);
  const padX = 14 * scale;
  const height = 38 * scale;
  const canvas = document.createElement('canvas');
  canvas.width = textW + padX * 2;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const r = height / 2;
  ctx.fillStyle = 'rgba(10,16,26,0.92)';
  ctx.strokeStyle = `#${ORIGIN_COLOUR[origin].toString(16).padStart(6, '0')}`;
  ctx.lineWidth = 2 * scale;
  ctx.beginPath();
  ctx.roundRect(ctx.lineWidth / 2, ctx.lineWidth / 2, canvas.width - ctx.lineWidth, height - ctx.lineWidth, r);
  ctx.fill();
  ctx.stroke();
  ctx.font = font;
  ctx.fillStyle = '#eaf3ff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padX, height / 2 + scale);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const entry = { texture, aspect: canvas.width / canvas.height };
  labelCache.set(key, entry);
  return entry;
}

class BeadView {
  readonly group = new Group();
  readonly sphere: Mesh;
  readonly diamond: Mesh;
  readonly ring: Mesh; // absent: the whole mark
  readonly accent: Mesh; // unresolved / unknown / confirmed accent ring
  readonly hit: Mesh;
  readonly label: Sprite;
  readonly line: Line;
  readonly linePositions = new Float32Array(6);
  readonly pos = new Vector3();
  readonly target = new Vector3();
  model: BeadModel | null = null;
  appear = 0;
  labelKey = '';
  selected = false;

  constructor() {
    const mat = () => new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.sphere = new Mesh(new SphereGeometry(CORE_R, 24, 16), mat());
    this.diamond = new Mesh(new OctahedronGeometry(CORE_R * 1.15), mat());
    this.ring = new Mesh(new TorusGeometry(CORE_R, 0.0065, 10, 40), mat());
    this.accent = new Mesh(new TorusGeometry(CORE_R * 1.55, 0.0045, 8, 40), mat());
    this.hit = new Mesh(new SphereGeometry(HIT_R, 10, 8), new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    this.label = new Sprite(new SpriteMaterial({ transparent: true, depthTest: false, toneMapped: false }));
    this.label.renderOrder = 20;
    // Sprites cannot be ray-cast without a camera on the raycaster, which the XR pointer does not provide: the label is
    // never a pick target (the invisible hit sphere is), and leaving this in throws inside the XR ray loop.
    this.label.raycast = () => undefined;
    this.group.add(this.sphere, this.diamond, this.ring, this.accent, this.hit, this.label);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.linePositions, 3));
    this.line = new Line(geometry, new LineBasicMaterial({ color: 0x8ab4ff, transparent: true, opacity: 0.45, depthTest: false }));
    this.line.frustumCulled = false;
    this.line.renderOrder = 9;
    this.group.visible = false;
  }
}

/**
 * Observation beads: each observation currently in the real session store appears as a small bead beside the model,
 * labelled with its short name. Chest-associated observations get a thin leader line to one shared chest hub, as an
 * orientation aid only; systemic ones (fever) float above with no line and no anatomical position. Shape says present,
 * absent, conflicting, or the patient's own statement; colour says where it came from.
 */
export class ObservationBeadsSystem extends createSystem({ roots: { required: [AnatomyRoot] } }) {
  private views: BeadView[] = [];
  private byId = new Map<string, BeadView>();
  private lastRevision = -1;
  private selectedId: string | null = null;
  private hub!: Mesh;
  private hubWorld!: Vector3;
  private head!: Vector3;
  private axis!: Vector3;
  private right!: Vector3;
  private forward!: Vector3;
  private base!: Vector3;
  private chestIndex = new Map<string, number>();
  private systemicIndex = new Map<string, number>();

  init(): void {
    this.hubWorld = new Vector3();
    this.head = new Vector3();
    this.axis = new Vector3();
    this.right = new Vector3();
    this.forward = new Vector3();
    this.base = new Vector3();
    this.hub = new Mesh(new TorusGeometry(0.02, 0.004, 8, 32), new MeshBasicMaterial({ color: 0x8ab4ff, transparent: true, opacity: 0.7, depthTest: false, toneMapped: false }));
    this.hub.renderOrder = 9;
    this.hub.visible = false;
    this.world.createTransformEntity(this.hub);

    for (let i = 0; i < MAX_BEADS; i++) {
      const view = new BeadView();
      view.group.name = `consult-bead-${i}`;
      const entity = this.world.createTransformEntity(view.group);
      entity.addComponent(RayInteractable);
      this.world.createTransformEntity(view.line);
      const onClick = (): void => {
        if (view.model) intentBus.emit({ type: 'SELECT_OBSERVATION', observationId: view.model.observationId }, this.source());
      };
      (view.group as unknown as { addEventListener: (t: string, f: () => void) => void }).addEventListener('click', onClick);
      this.views.push(view);
    }
  }

  private source(): IntentSource {
    return this.renderer.xr.isPresenting ? 'hand' : 'desktop';
  }

  private sync(beads: readonly BeadModel[]): void {
    const wanted = new Set(beads.map((b) => b.observationId));
    for (const [id, view] of this.byId) {
      if (!wanted.has(id)) {
        view.model = null;
        view.group.visible = false;
        view.line.visible = false;
        this.byId.delete(id);
        livePositions.delete(id);
      }
    }
    this.chestIndex.clear();
    this.systemicIndex.clear();
    for (const bead of beads) {
      const map = bead.anchor === 'CHEST_REGION' ? this.chestIndex : this.systemicIndex;
      map.set(bead.observationId, map.size);
      let view = this.byId.get(bead.observationId);
      if (!view) {
        view = this.views.find((v) => !v.model);
        if (!view) continue; // more observations than beads: the pool is generous, extras are simply not drawn
        this.byId.set(bead.observationId, view);
        view.appear = 0;
        view.group.visible = true;
        view.pos.set(0, -50, 0); // placed at its row on the next update
        view.target.set(0, -50, 0);
      }
      this.paintBead(view, bead);
    }
  }

  private paintBead(view: BeadView, bead: BeadModel): void {
    view.model = bead;
    const colour = ORIGIN_COLOUR[bead.origin];
    const set = (m: Mesh, on: boolean, c: number): void => {
      m.visible = on;
      (m.material as MeshBasicMaterial).color.setHex(c);
    };
    const present = bead.presence === 'PRESENT';
    set(view.sphere, present || bead.presence === 'UNRESOLVED' || bead.presence === 'UNKNOWN', colour);
    set(view.diamond, bead.presence === 'MENTIONED', colour);
    set(view.ring, bead.presence === 'ABSENT', colour);
    const accent = bead.presence === 'UNRESOLVED' ? UNRESOLVED_COLOUR : bead.origin === 'DOCTOR_CONFIRMED' ? ORIGIN_COLOUR.DOCTOR_CONFIRMED : colour;
    set(view.accent, bead.presence === 'UNRESOLVED' || bead.presence === 'UNKNOWN' || bead.origin === 'DOCTOR_CONFIRMED', accent);
    view.sphere.scale.setScalar(bead.presence === 'UNKNOWN' ? 0.65 : 1);
    (view.line.material as LineBasicMaterial).color.setHex(colour);
    view.line.visible = bead.anchor === 'CHEST_REGION';

    const key = `${bead.origin}|${bead.label}`;
    if (key !== view.labelKey) {
      view.labelKey = key;
      const tex = labelTexture(bead.label, bead.origin);
      const material = view.label.material as SpriteMaterial;
      material.map = tex.texture;
      material.needsUpdate = true;
      view.label.scale.set(LABEL_H * tex.aspect, LABEL_H, 1);
      view.label.position.set(HIT_R + 0.01 + (LABEL_H * tex.aspect) / 2, 0, 0);
      labelReach.set(bead.observationId, HIT_R + 0.01 + LABEL_H * tex.aspect);
    }
  }

  update(delta: number, time: number): void {
    const snap = consultApp.getSnapshot();
    if (snap.revision !== this.lastRevision) {
      this.lastRevision = snap.revision;
      this.selectedId = snap.selectedObservationId;
      this.sync(snap.beads);
    }
    const root = this.queries.roots.entities.values().next().value;
    const rootObject = root?.object3D;
    if (!rootObject || this.byId.size === 0) {
      this.hub.visible = false;
      return;
    }
    rootObject.getWorldPosition(this.axis);
    this.player.head.getWorldPosition(this.head);
    this.forward.set(this.axis.x - this.head.x, 0, this.axis.z - this.head.z).normalize();
    this.right.set(-this.forward.z, 0, this.forward.x);

    const chest = anatomyStore.ready ? anatomyStore.getRegistry().get('respiratory')?.center : undefined;
    if (chest) {
      this.hubWorld.set(chest[0], chest[1], chest[2]);
      rootObject.localToWorld(this.hubWorld);
    }
    this.hub.visible = !!chest && this.chestIndex.size > 0;
    if (this.hub.visible) {
      this.hub.position.copy(this.hubWorld);
      this.hub.lookAt(this.head);
    }

    const k = 1 - Math.exp(-motion.smoothing * delta);
    for (const [id, view] of this.byId) {
      const bead = view.model;
      if (!bead) continue;
      const chestRow = this.chestIndex.get(id);
      const systemicRow = this.systemicIndex.get(id);
      const y = chestRow !== undefined ? this.axis.y + 0.2 - chestRow * ROW : this.axis.y + 0.34 + (systemicRow ?? 0) * ROW;
      this.base.copy(this.axis).addScaledVector(this.right, COLUMN_X).addScaledVector(this.forward, -0.06);
      view.target.set(this.base.x, y, this.base.z);
      if (view.pos.y < -40) {
        // a new bead emerges from the chest hub (chest-associated) or from beside the model (systemic)
        if (chestRow !== undefined && chest) view.pos.copy(this.hubWorld);
        else view.pos.set(this.axis.x, y, this.axis.z);
      }
      view.pos.lerp(view.target, k);
      view.appear = Math.min(1, view.appear + delta / motion.base);
      const selected = id === this.selectedId;
      const pulse = bead.presence === 'UNRESOLVED' ? 1 + 0.12 * Math.sin(time * 3.2) : 1;
      view.group.position.copy(view.pos);
      view.group.scale.setScalar((0.2 + 0.8 * view.appear) * (selected ? 1.12 : 1));
      view.accent.scale.setScalar(pulse);
      view.group.quaternion.identity();
      livePositions.set(id, view.pos);

      if (view.line.visible && chest) {
        const p = view.linePositions;
        p[0] = view.pos.x; p[1] = view.pos.y; p[2] = view.pos.z;
        p[3] = this.hubWorld.x; p[4] = this.hubWorld.y; p[5] = this.hubWorld.z;
        view.line.geometry.attributes.position.needsUpdate = true;
        (view.line.material as LineBasicMaterial).opacity = selected ? 0.9 : 0.45;
      }
    }
  }
}
