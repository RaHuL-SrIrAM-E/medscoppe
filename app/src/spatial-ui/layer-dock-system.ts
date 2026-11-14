import { createSystem, type UIKit, type UIKitMLAsset } from '@iwsdk/core';
import { anatomyStore, type SystemMode } from '../anatomy/anatomy-state.js';
import { intentBus, type Intent, type IntentSource } from '../core/intents.js';
import { systemColors, type AnatomicalSystemId } from '../design/tokens.js';

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

interface Chip {
  system: AnatomicalSystemId | null; // null = reset
  intent: Intent;
  button: ReturnType<UIKitMLAsset['getElementById']>;
  label: UIKit.Text | null;
}

/**
 * The layer dock: a small panel under the model, reachable by hand. It only
 * emits intents and mirrors store state; it holds no anatomy logic.
 */
export class LayerDockSystem extends createSystem({}) {
  private chips: Chip[] = [];
  private bound = false;

  update(): void {
    if (!this.bound) this.tryBind();
  }

  private source(): IntentSource {
    return this.renderer.xr.isPresenting ? 'hand' : 'desktop';
  }

  private tryBind(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('layer-dock');
    if (!panel || !anatomyStore.ready) return;
    const registry = anatomyStore.getRegistry();
    const present = new Set(registry.systemsWithGeometry());

    const defs: Array<[string, AnatomicalSystemId | null, Intent]> = [
      ['respiratory', 'respiratory', { type: 'SET_ANATOMICAL_SYSTEM', system: 'respiratory' }],
      ['skeletal', 'skeletal', { type: 'SET_ANATOMICAL_SYSTEM', system: 'skeletal' }],
      ['surface', 'surface', { type: 'SET_ANATOMICAL_SYSTEM', system: 'surface' }],
      ['reset', null, { type: 'RESET_VIEW' }],
    ];
    for (const [key, system, intent] of defs) {
      const button = panel.getElementById(`chip-${key}`);
      const label = panel.getElementById<UIKit.Text>(`label-${key}`);
      if (!button) continue;
      if (system && !present.has(system)) {
        button.setProperties({ display: 'none' }); // e.g. muscular/nervous are not loaded yet
        continue;
      }
      const onClick = (): void => intentBus.emit(intent, this.source());
      button.addEventListener('click', onClick);
      this.cleanupFuncs.push(() => button.removeEventListener('click', onClick));
      this.chips.push({ system, intent, button, label });
    }
    this.cleanupFuncs.push(anatomyStore.subscribe(() => this.paint()));
    this.paint();
    this.bound = true;
  }

  private paint(): void {
    const modes = anatomyStore.get().systemModes;
    for (const chip of this.chips) {
      if (!chip.system) continue;
      const mode: SystemMode = modes[chip.system] ?? 'hidden';
      const colour = hex(systemColors[chip.system]);
      chip.button?.setProperties(
        mode === 'active'
          ? { backgroundColor: colour, borderColor: colour }
          : mode === 'ghost'
            ? { backgroundColor: '#142033', borderColor: colour }
            : { backgroundColor: '#0b121c', borderColor: '#2a3b52' },
      );
      chip.label?.setProperties({ color: mode === 'active' ? '#06101a' : mode === 'ghost' ? '#cfe3f5' : '#6f8399' });
    }
  }
}
