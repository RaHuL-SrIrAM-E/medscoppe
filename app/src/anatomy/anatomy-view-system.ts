import { Color, createSystem, type Entity, Mesh, MeshStandardMaterial } from '@iwsdk/core';
import { accent, motion, systemColors } from '../design/tokens.js';
import { anatomyStore, deriveVisual, type Visual } from './anatomy-state.js';
import { AnatomyRoot } from './anatomy-component.js';

const NOOP_RAYCAST: Mesh['raycast'] = () => {};

/** Per-structure tint within a system hue, so cartilage and airways read apart from bone and lung. */
function baseColor(id: string, system: keyof typeof systemColors): number {
  if (id.includes('cartilage')) return 0xbcd6e6;
  if (id.includes('pulmonary-artery')) return 0x4f86ff; // atlas convention: pulmonary arteries blue
  if (id.includes('pulmonary-vein')) return 0xe5525d; // pulmonary veins red
  if (id.startsWith('respiratory.airway')) return 0xc4f1ff;
  if (id.startsWith('respiratory.diaphragm')) return 0xd98a6a;
  return systemColors[system];
}

interface MeshView {
  id: string;
  mesh: Mesh;
  material: MeshStandardMaterial;
  base: Color;
  originalRaycast: Mesh['raycast'];
  target: Visual;
  opacity: number;
  emphasis: number;
}

/**
 * Applies AnatomyState to the anatomy GLB: layer visibility, ghosting,
 * isolation, hover and selection highlight, with smooth transitions. It reads
 * state only from the store; it never reads input.
 */
export class AnatomyViewSystem extends createSystem({
  roots: { required: [AnatomyRoot] },
}) {
  private views: MeshView[] = [];
  private accent!: Color;

  init(): void {
    this.accent = new Color(accent);
    for (const entity of this.queries.roots.entities) this.bind(entity);
    this.cleanupFuncs.push(
      this.queries.roots.subscribe('qualify', (entity) => this.bind(entity)),
      anatomyStore.subscribe(() => this.retarget(false)),
    );
  }

  private bind(entity: Entity): void {
    const object = entity.object3D;
    if (!object || !anatomyStore.ready) return;
    const registry = anatomyStore.getRegistry();
    this.views = [];
    object.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      const id = registry.idForNode(child.name);
      const def = id ? registry.get(id) : undefined;
      if (!def) return;
      const base = new Color(baseColor(def.id, def.system as keyof typeof systemColors));
      const material = new MeshStandardMaterial({
        color: base,
        roughness: 0.55,
        metalness: 0,
        emissive: this.accent,
        emissiveIntensity: 0,
        transparent: true,
        opacity: 0,
      });
      child.material = material; // fresh material per mesh: nothing shared is mutated
      child.castShadow = false;
      child.receiveShadow = false;
      this.views.push({
        id: def.id,
        mesh: child,
        material,
        base,
        originalRaycast: child.raycast,
        target: { visible: false, opacity: 0, emphasis: 0, pickable: false },
        opacity: 0,
        emphasis: 0,
      });
    });
    this.retarget(true);
  }

  /** Recompute each mesh's target from state. Runs on state change, not per frame. */
  private retarget(snap: boolean): void {
    const state = anatomyStore.get();
    const registry = anatomyStore.getRegistry();
    for (const view of this.views) {
      const target = deriveVisual(state, registry, view.id);
      view.target = target;
      view.mesh.raycast = target.pickable ? view.originalRaycast : NOOP_RAYCAST;
      if (snap) {
        view.opacity = target.opacity;
        view.emphasis = target.emphasis;
      }
    }
  }

  update(delta: number): void {
    const k = 1 - Math.exp(-motion.smoothing * delta);
    for (const view of this.views) {
      view.opacity += (view.target.opacity - view.opacity) * k;
      view.emphasis += (view.target.emphasis - view.emphasis) * k;
      const material = view.material;
      const visible = view.target.visible || view.opacity > 0.01;
      view.mesh.visible = visible;
      if (!visible) continue;
      material.opacity = view.opacity;
      material.depthWrite = view.opacity > 0.65;
      material.color.copy(view.base).lerp(this.accent, view.emphasis * 0.4);
      material.emissiveIntensity = view.emphasis * 0.85;
    }
  }
}
