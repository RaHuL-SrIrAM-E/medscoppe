import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
  createSystem,
  type UIKit,
  type UIKitMLAsset,
} from '@iwsdk/core';
import { AnatomyRoot } from '../anatomy/anatomy-component.js';
import { anatomyStore } from '../anatomy/anatomy-state.js';
import { describeStructure, loadStructureInfo, type InfoDoc } from '../anatomy/structure-info.js';
import { intentBus, type IntentSource } from '../core/intents.js';
import { accent, motion } from '../design/tokens.js';

const HIDDEN_Y = -10;
/** Horizontal distance from the model axis to the card centre, metres. */
const SIDE_OFFSET = 0.6;
const CARD_HALF_WIDTH = 0.2;

/**
 * Contextual information that emerges from the selected structure: a small
 * card floats beside the body, tethered to the structure by a leader line, and
 * turns to face the viewer. It follows the structure as the model rotates.
 */
export class InfoCardSystem extends createSystem({
  roots: { required: [AnatomyRoot] },
}) {
  private panel: UIKitMLAsset | null = null;
  private doc: InfoDoc | null = null;
  private els: Record<string, UIKit.Text | null> = {};
  private details = false;
  private shown = false;

  private anchor!: Vector3;
  private head!: Vector3;
  private axis!: Vector3;
  private target!: Vector3;
  private right!: Vector3;
  private forward!: Vector3;
  private edge!: Vector3;
  private linePositions!: Float32Array;
  private line!: Line;
  private lineGeometry!: BufferGeometry;
  private marker!: Mesh;
  private group!: Group;

  init(): void {
    this.anchor = new Vector3();
    this.head = new Vector3();
    this.axis = new Vector3();
    this.target = new Vector3();
    this.right = new Vector3();
    this.forward = new Vector3();
    this.edge = new Vector3();
    this.linePositions = new Float32Array(6);
    this.lineGeometry = new BufferGeometry();
    this.lineGeometry.setAttribute('position', new BufferAttribute(this.linePositions, 3));
    this.line = new Line(this.lineGeometry, new LineBasicMaterial({ color: accent, transparent: true, opacity: 0.85, depthTest: false }));
    this.line.frustumCulled = false;
    this.line.renderOrder = 10;
    this.marker = new Mesh(new SphereGeometry(0.013, 16, 12), new MeshBasicMaterial({ color: accent, depthTest: false }));
    this.marker.renderOrder = 11;
    this.group = new Group();
    this.group.add(this.line, this.marker);
    this.group.visible = false;
    this.world.createTransformEntity(this.group);

    loadStructureInfo(`${import.meta.env.BASE_URL}anatomy/structure-info.json`)
      .then((doc) => {
        this.doc = doc;
        this.render();
      })
      .catch((error: unknown) => console.warn('[info-card] structure info unavailable', error));
    this.cleanupFuncs.push(
      anatomyStore.subscribe((state, previous) => {
        if (state.selectedId !== previous.selectedId) this.details = state.infoOpen;
        else if (state.infoOpen !== previous.infoOpen) this.details = state.infoOpen;
        this.render();
      }),
    );
  }

  private source(): IntentSource {
    return this.renderer.xr.isPresenting ? 'hand' : 'desktop';
  }

  private tryBind(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('info-card');
    if (!panel) return;
    for (const id of ['title', 'subtitle', 'partof', 'notice', 'body', 'note']) {
      this.els[id] = panel.getElementById<UIKit.Text>(id);
    }
    const wire = (id: string, handler: () => void): void => {
      const element = panel.getElementById(id);
      if (!element) return;
      element.addEventListener('click', handler);
      this.cleanupFuncs.push(() => element.removeEventListener('click', handler));
    };
    wire('btn-isolate', () => {
      const state = anatomyStore.get();
      if (!state.selectedId) return;
      intentBus.emit(
        state.isolatedId ? { type: 'CLEAR_ISOLATION' } : { type: 'ISOLATE_STRUCTURE', structureId: state.selectedId },
        this.source(),
      );
    });
    wire('btn-details', () => {
      const state = anatomyStore.get();
      if (!state.selectedId) return;
      intentBus.emit(
        state.infoOpen
          ? { type: 'HIDE_CLINICAL_INFORMATION' }
          : { type: 'SHOW_CLINICAL_INFORMATION', structureId: state.selectedId },
        this.source(),
      );
    });
    wire('btn-close', () => {
      intentBus.emit({ type: 'CLEAR_ISOLATION' }, this.source());
      intentBus.emit({ type: 'CLEAR_SELECTION' }, this.source());
    });
    this.panel = panel;
    panel.position.set(0, HIDDEN_Y, 0);
    this.render();
  }

  /** Update card text for the current selection. Runs on state change only. */
  private render(): void {
    if (!this.panel || !this.doc || !anatomyStore.ready) return;
    const state = anatomyStore.get();
    const info = state.selectedId ? describeStructure(anatomyStore.getRegistry(), this.doc, state.selectedId) : null;
    this.shown = !!info;
    if (!info) return;
    const set = (id: string, props: Record<string, unknown>): void => this.els[id]?.setProperties(props);
    set('title', { text: info.title });
    set('subtitle', { text: info.systemName });
    set('partof', { text: info.partOf, display: info.partOf ? 'flex' : 'none' });
    set('notice', { text: info.notice ?? '', display: info.notice ? 'flex' : 'none' });
    set('body', { text: info.summary, display: this.details ? 'flex' : 'none' });
    set('note', { text: info.approximate ? 'Approximate shape. Educational text, pending clinician review.' : 'Educational text. Pending clinician review.', display: this.details ? 'flex' : 'none' });
    const buttons = this.panel;
    buttons.getElementById<UIKit.Text>('btn-isolate-label')?.setProperties({ text: state.isolatedId ? 'Show all' : 'Isolate' });
    buttons.getElementById<UIKit.Text>('btn-details-label')?.setProperties({ text: this.details ? 'Less' : 'Details' });
  }

  update(delta: number): void {
    if (!this.panel) {
      this.tryBind();
      return;
    }
    const state = anatomyStore.get();
    const root = this.queries.roots.entities.values().next().value;
    const rootObject = root?.object3D;
    const def = state.selectedId ? anatomyStore.getRegistry().get(state.selectedId) : undefined;
    const visible = this.shown && !!rootObject && !!def?.center;
    this.group.visible = visible;
    if (!visible || !rootObject || !def?.center) {
      this.panel.position.y += (HIDDEN_Y - this.panel.position.y) * 0.5;
      if (this.panel.position.y < HIDDEN_Y + 1) this.panel.position.y = HIDDEN_Y;
      return;
    }

    // Anchor on the selected structure, in world space (follows model rotation).
    this.anchor.set(def.center[0], def.center[1], def.center[2]);
    rootObject.localToWorld(this.anchor);
    rootObject.getWorldPosition(this.axis);
    this.player.head.getWorldPosition(this.head);

    // Viewer-relative right vector (horizontal) and the side of the body the structure is on.
    this.forward.set(this.axis.x - this.head.x, 0, this.axis.z - this.head.z).normalize();
    this.right.set(-this.forward.z, 0, this.forward.x);
    const side = (this.anchor.x - this.axis.x) * this.right.x + (this.anchor.z - this.axis.z) * this.right.z >= 0 ? 1 : -1;

    this.target
      .copy(this.axis)
      .addScaledVector(this.right, side * SIDE_OFFSET)
      .addScaledVector(this.forward, -0.05);
    this.target.y = this.anchor.y + 0.04;

    const k = 1 - Math.exp(-motion.smoothing * delta);
    if (this.panel.position.y < HIDDEN_Y + 1) this.panel.position.copy(this.target); // appear in place
    else this.panel.position.lerp(this.target, k);
    this.panel.lookAt(this.head);

    // Leader line: structure -> nearest card edge.
    this.edge.copy(this.panel.position).addScaledVector(this.right, -side * CARD_HALF_WIDTH);
    const p = this.linePositions;
    p[0] = this.anchor.x; p[1] = this.anchor.y; p[2] = this.anchor.z;
    p[3] = this.edge.x; p[4] = this.edge.y; p[5] = this.edge.z;
    this.lineGeometry.attributes.position.needsUpdate = true;
    this.marker.position.copy(this.anchor);
  }
}
