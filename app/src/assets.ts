import { defineAssets } from '@iwsdk/core';
import { createFloorRings } from './scene-assets/floor-rings.scene-asset.js';
import { createAnatomyPlaceholder } from './scene-assets/anatomy-placeholder.scene-asset.js';

export default defineAssets({
  'anatomy-placeholder': createAnatomyPlaceholder(),
  'floor-rings': createFloorRings(),
});
