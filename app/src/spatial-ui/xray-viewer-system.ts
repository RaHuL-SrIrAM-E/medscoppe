import {
  Box3, BufferAttribute, BufferGeometry, CanvasTexture, Group, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry,
  SRGBColorSpace, Vector3, createSystem,
} from '@iwsdk/core';
import { AnatomyRoot } from '../anatomy/anatomy-component.js';
import { anatomyStore } from '../anatomy/anatomy-state.js';
import { consultApp } from '../consult/app/consult-singleton.js';
import type { XrayModel } from '../consult/ui/consult-view-model.js';
import { intentBus, type IntentSource } from '../core/intents.js';
import { motion } from '../design/tokens.js';
import { FIELD_H, FILM_H, FILM_W, drawChestFilm } from './xray-film.js';

const HIDDEN_Y = -10;
const FILM_WIDTH_M = 0.3;
const FILM_HEIGHT_M = (FILM_WIDTH_M * FILM_H) / FILM_W;
const FIELD_FRACTION = FIELD_H / FILM_H; // the film area as a share of the whole canvas (the rest is the caption band)
const LATERAL = 0.62; // metres to the viewer-left of the model axis: the same column as the reference card, stacked above it
const BEHIND = 0.05;
const LIFT = 0.38; // above the model axis, clear of the card below

/**
 * Shows the ILLUSTRATIVE chest film for the condition whose reference the doctor is reading, and, on request, glows the
 * matching structures in the 3D body with a leader line from the circled finding to them. It owns no state: the card
 * model decides what is shown (`card.xray`); this only paints it and asks the anatomy store to glow structures.
 */
export class XrayViewerSystem extends createSystem({ roots: { required: [AnatomyRoot] } }) {
  private group!: Group;
  private film!: Mesh;
  private canvas!: HTMLCanvasElement;
  private texture!: CanvasTexture;
  private line!: Line;
  private linePositions!: Float32Array;
  private lineGeometry!: BufferGeometry;
  private head!: Vector3;
  private axis!: Vector3;
  private right!: Vector3;
  private forward!: Vector3;
  private target!: Vector3;
  private finding!: Vector3;
  private structure!: Vector3;
  private box!: Box3;
  private tmpBox!: Box3;
  private structureLocal: Vector3 | null = null;
  private drawnKey = '';
  private appliedKey = '';
  private shown = false;

  init(): void {
    this.head = new Vector3();
    this.axis = new Vector3();
    this.right = new Vector3();
    this.forward = new Vector3();
    this.target = new Vector3();
    this.finding = new Vector3();
    this.structure = new Vector3();
    this.box = new Box3();
    this.tmpBox = new Box3();

    this.canvas = document.createElement('canvas');
    this.canvas.width = FILM_W;
    this.canvas.height = FILM_H;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.film = new Mesh(new PlaneGeometry(FILM_WIDTH_M, FILM_HEIGHT_M), new MeshBasicMaterial({ map: this.texture, toneMapped: false }));
    const frame = new Mesh(new PlaneGeometry(FILM_WIDTH_M + 0.014, FILM_HEIGHT_M + 0.014), new MeshBasicMaterial({ color: 0x7cf2d4 }));
    frame.position.z = -0.002;
    this.group = new Group();
    this.group.add(frame, this.film);

    this.linePositions = new Float32Array(6);
    this.lineGeometry = new BufferGeometry();
    this.lineGeometry.setAttribute('position', new BufferAttribute(this.linePositions, 3));
    this.line = new Line(this.lineGeometry, new LineBasicMaterial({ color: 0x7cf2d4, transparent: true, opacity: 0.9, depthTest: true }));
    this.line.frustumCulled = false;
    this.line.renderOrder = 12;
    this.line.visible = false;

    this.group.position.set(0, HIDDEN_Y, 0);
    this.world.createTransformEntity(this.group);
    this.world.createTransformEntity(this.line);
  }

  private source(): IntentSource {
    return this.renderer.xr.isPresenting ? 'hand' : 'desktop';
  }

  /** Union box of every mesh that belongs to one of the structures, as a position local to the anatomy root. */
  private locate(root: Object3D, ids: readonly string[]): Vector3 | null {
    const registry = anatomyStore.getRegistry();
    this.box.makeEmpty();
    root.updateWorldMatrix(true, true);
    root.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      const id = registry.idForNode(child.name);
      if (!id || !ids.some((s) => registry.isWithin(id, s))) return;
      this.box.union(this.tmpBox.setFromObject(child));
    });
    if (this.box.isEmpty()) return null;
    return root.worldToLocal(this.box.getCenter(new Vector3()));
  }

  /** Make the matching structures glow (and bring the respiratory system forward if it is not), or clear the glow. */
  private applyLocate(x: XrayModel | null, root: Object3D | undefined): void {
    const key = x && x.mode === 'LOCATE' ? `${x.conditionName}` : '';
    if (key === this.appliedKey) return;
    this.appliedKey = key;
    if (!x || !key || !root) {
      this.structureLocal = null;
      intentBus.emit({ type: 'CLEAR_HIGHLIGHT' }, this.source());
      return;
    }
    if (anatomyStore.get().systemModes.respiratory !== 'active') intentBus.emit({ type: 'SET_ANATOMICAL_SYSTEM', system: 'respiratory' }, this.source());
    intentBus.emit({ type: 'HIGHLIGHT_STRUCTURES', structureIds: x.finding.structureIds }, this.source());
    this.structureLocal = this.locate(root, x.finding.structureIds);
  }

  update(delta: number): void {
    const card = consultApp.getSnapshot().card;
    const x = card?.xray && card.xray.mode !== 'OFF' ? card.xray : null;
    const root = this.queries.roots.entities.values().next().value;
    const rootObject = root?.object3D ?? undefined;

    this.applyLocate(x, rootObject);

    if (!x || !rootObject) {
      this.line.visible = false;
      if (this.shown) {
        this.group.position.y = HIDDEN_Y;
        this.shown = false;
      }
      return;
    }

    const key = `${x.conditionName}|${x.finding.pattern}`;
    if (key !== this.drawnKey) {
      this.drawnKey = key;
      const ctx = this.canvas.getContext('2d');
      if (ctx) {
        drawChestFilm(ctx, x.finding, x.conditionName);
        this.texture.needsUpdate = true;
      }
    }

    rootObject.getWorldPosition(this.axis);
    this.player.head.getWorldPosition(this.head);
    this.forward.set(this.axis.x - this.head.x, 0, this.axis.z - this.head.z).normalize();
    this.right.set(-this.forward.z, 0, this.forward.x);
    this.target.copy(this.axis).addScaledVector(this.right, -LATERAL).addScaledVector(this.forward, BEHIND);
    this.target.y = this.axis.y + LIFT;
    if (!this.shown) {
      this.group.position.copy(this.target);
      this.shown = true;
    } else this.group.position.lerp(this.target, 1 - Math.exp(-motion.smoothing * delta));
    this.group.lookAt(this.head);
    this.group.updateMatrixWorld(true);

    // leader line from the circled finding on the film to the structure it describes
    const show = x.mode === 'LOCATE' && this.structureLocal !== null;
    this.line.visible = show;
    if (show && this.structureLocal) {
      const fx = (x.finding.marker.x - 0.5) * FILM_WIDTH_M;
      const fy = (0.5 - x.finding.marker.y * FIELD_FRACTION) * FILM_HEIGHT_M;
      this.finding.set(fx, fy, 0.004);
      this.group.localToWorld(this.finding);
      this.structure.copy(this.structureLocal);
      rootObject.localToWorld(this.structure);
      const p = this.linePositions;
      p[0] = this.finding.x; p[1] = this.finding.y; p[2] = this.finding.z;
      p[3] = this.structure.x; p[4] = this.structure.y; p[5] = this.structure.z;
      this.lineGeometry.attributes.position.needsUpdate = true;
    }
  }
}
