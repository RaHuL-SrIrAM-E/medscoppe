import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { AnatomyPlaceholderSystem } from './anatomy/placeholder-system.js';
import { AnatomyPointerSystem } from './interaction/anatomy-pointer-system.js';
import { preferEmulatedHands } from './interaction/emulator-hands.js';
import { intentBus } from './core/intents.js';
import { installDesktopAdapter } from './interaction/desktop-adapter.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(AnatomyPlaceholderSystem);
  world.registerSystem(AnatomyPointerSystem);
  if (import.meta.env.DEV) {
    preferEmulatedHands();
    intentBus.subscribe((e) => console.info('[intent]', JSON.stringify(e)));
  }
  installDesktopAdapter();
});
