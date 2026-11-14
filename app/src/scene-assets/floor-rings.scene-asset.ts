import { DoubleSide, Group, Mesh, MeshBasicMaterial, RingGeometry } from '@iwsdk/core';
import { accent, surface } from '../design/tokens.js';

/**
 * Faint concentric rings on the floor beneath the anatomy. They give the void a
 * sense of scale and depth (and a ground reference in XR) without becoming UI.
 */
export function createFloorRings(): Group {
  const root = new Group();
  root.name = 'floor-rings';
  const radii: Array<[number, number, number]> = [
    [0.45, 0.455, 0.5],
    [0.85, 0.855, 0.3],
    [1.4, 1.405, 0.16],
  ];
  radii.forEach(([inner, outer, opacity], i) => {
    const ring = new Mesh(
      new RingGeometry(inner, outer, 96),
      new MeshBasicMaterial({
        color: i === 0 ? accent : surface.glassEdge,
        transparent: true,
        opacity,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    ring.name = `ring-${i}`;
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.001;
    root.add(ring);
  });
  return root;
}
