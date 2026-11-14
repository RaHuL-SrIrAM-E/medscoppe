import { createComponent, Types } from '@iwsdk/core';

/** Marks the entity that holds the anatomical model. System-free on purpose. */
export const AnatomyRoot = createComponent('AnatomyRoot', {
  activeSystem: { type: Types.String, default: 'skeletal' },
});
