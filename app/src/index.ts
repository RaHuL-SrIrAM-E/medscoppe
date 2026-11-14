import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { anatomyStore } from './anatomy/anatomy-state.js';
import { AnatomyViewSystem } from './anatomy/anatomy-view-system.js';
import { loadRegistry } from './anatomy/registry.js';
import { intentBus } from './core/intents.js';
import { AnatomyPointerSystem } from './interaction/anatomy-pointer-system.js';
import { installDesktopAdapter } from './interaction/desktop-adapter.js';
import { consultApp } from './consult/app/consult-singleton.js';
import { ConsultControlsSystem } from './spatial-ui/consult-controls-system.js';
import { InfoCardSystem } from './spatial-ui/info-card-system.js';
import { LayerDockSystem } from './spatial-ui/layer-dock-system.js';
import { ObservationBeadsSystem } from './spatial-ui/observation-beads-system.js';
import { ObservationCardSystem } from './spatial-ui/observation-card-system.js';
import { preferEmulatedHands } from './interaction/emulator-hands.js';

// The registry must exist before any system binds to the anatomy model.
anatomyStore.init(await loadRegistry(`${import.meta.env.BASE_URL}anatomy/structures.json`));
intentBus.subscribe(({ intent }) => anatomyStore.dispatch(intent));

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(AnatomyViewSystem);
  world.registerSystem(AnatomyPointerSystem);
  world.registerSystem(LayerDockSystem);
  world.registerSystem(InfoCardSystem);
  world.registerSystem(ConsultControlsSystem);
  world.registerSystem(ObservationBeadsSystem);
  world.registerSystem(ObservationCardSystem);
  installDesktopAdapter();
  if (import.meta.env.DEV) {
    preferEmulatedHands();
    intentBus.subscribe((e) => console.info('[intent]', JSON.stringify(e)));
    // Dev-only: lets scripts/verify-*.sh assert on state, not just pixels.
    consultApp.subscribe((s) =>
      console.info('[consult]', JSON.stringify({ life: s.controls.lifecycle, beads: s.beads.map((b) => b.label), origins: s.beads.map((b) => b.origin), sel: s.selectedObservationId, ext: s.controls.extractionLabel, src: s.extractionSource, err: s.controls.errorLine })),
    );
    anatomyStore.subscribe((s) =>
      console.info('[state]', JSON.stringify({ sel: s.selectedId, iso: s.isolatedId, info: s.infoOpen, modes: s.systemModes })),
    );
  }
});
