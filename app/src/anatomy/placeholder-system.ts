import { Color, createSystem, type Entity, Mesh, MeshStandardMaterial } from '@iwsdk/core';
import { intentBus } from '../core/intents.js';
import { accent, motion, systemColors } from '../design/tokens.js';
import { AnatomyRoot } from './anatomy-component.js';

/**
 * Phase 0 behaviour for the placeholder model: idle "breathing" and a
 * cross-fade tint when SET_ANATOMICAL_SYSTEM arrives. It exists to prove the
 * intent -> system -> render loop; Phase 1 replaces it with real layers.
 */
export class AnatomyPlaceholderSystem extends createSystem({
  roots: { required: [AnatomyRoot] },
}) {
  private materials: MeshStandardMaterial[] = [];
  private byName = new Map<string, MeshStandardMaterial>();
  private selected: MeshStandardMaterial | null = null;
  private accent!: Color;
  private target!: Color;
  private baseScaleY = 1;

  init(): void {
    this.target = new Color(systemColors.skeletal);
    this.accent = new Color(accent);

    // The level may already be loaded when this system registers, so bind
    // existing entities as well as ones that qualify later.
    for (const entity of this.queries.roots.entities) this.bind(entity);
    this.cleanupFuncs.push(
      this.queries.roots.subscribe('qualify', (entity) => this.bind(entity)),
    );

    this.cleanupFuncs.push(
      intentBus.subscribe(({ intent }) => {
        if (intent.type === 'SET_ANATOMICAL_SYSTEM') {
          this.target.setHex(systemColors[intent.system]);
        } else if (intent.type === 'SELECT_STRUCTURE') {
          const next = this.byName.get(intent.structureId) ?? null;
          this.selected = this.selected === next ? null : next;
        }
      }),
    );
  }

  private bind(entity: Entity): void {
    const object = entity.object3D;
    if (!object) return;
    this.baseScaleY = object.scale.y;
    // Clone materials per instance so tinting never touches the shared prototype.
    this.materials = [];
    this.byName.clear();
    object.traverse((child) => {
      if (child instanceof Mesh && child.material instanceof MeshStandardMaterial) {
        child.material = child.material.clone();
        this.materials.push(child.material);
        this.byName.set(child.name, child.material);
      }
    });
  }

  update(delta: number, time: number): void {
    const k = 1 - Math.exp(-motion.smoothing * delta);
    for (const material of this.materials) {
      const isSelected = material === this.selected;
      material.color.lerp(isSelected ? this.accent : this.target, k);
      material.emissive.lerp(isSelected ? this.accent : this.target, k);
      material.emissiveIntensity +=
        ((isSelected ? 0.9 : 0.12) - material.emissiveIntensity) * k;
    }
    for (const entity of this.queries.roots.entities) {
      const object = entity.object3D;
      if (object) object.scale.y = this.baseScaleY * (1 + 0.006 * Math.sin(time * 1.4));
    }
  }
}
