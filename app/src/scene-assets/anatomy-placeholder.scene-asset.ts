import {
  CapsuleGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  MeshBasicMaterial,
  DoubleSide,
} from '@iwsdk/core';
import { surface, systemColors } from '../design/tokens.js';

/**
 * Phase 0 stand-in for the real anatomy (BodyParts3D GLB arrives in Phase 1).
 * Built at true scale (about 1.7 m, origin at the feet) with named parts so the
 * structure registry can later match by name. Replace, don't extend.
 */
export function createAnatomyPlaceholder(): Group {
  const root = new Group();
  root.name = 'anatomy-placeholder';

  const body = new MeshStandardMaterial({
    color: systemColors.skeletal,
    roughness: 0.45,
    metalness: 0.05,
    emissive: systemColors.skeletal,
    emissiveIntensity: 0.12,
  });

  const part = (
    name: string,
    mesh: Mesh,
    x: number,
    y: number,
    z = 0,
    rotZ = 0,
  ): void => {
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.rotation.z = rotZ;
    root.add(mesh);
  };

  part('skull', new Mesh(new SphereGeometry(0.1, 32, 24), body), 0, 1.62);
  part('spine', new Mesh(new CapsuleGeometry(0.03, 0.55, 8, 16), body), 0, 1.2);
  part('pelvis', new Mesh(new TorusGeometry(0.1, 0.035, 12, 32), body), 0, 0.92);
  part('femur-l', new Mesh(new CapsuleGeometry(0.035, 0.38, 8, 16), body), -0.1, 0.62);
  part('femur-r', new Mesh(new CapsuleGeometry(0.035, 0.38, 8, 16), body), 0.1, 0.62);
  part('tibia-l', new Mesh(new CapsuleGeometry(0.028, 0.36, 8, 16), body), -0.1, 0.22);
  part('tibia-r', new Mesh(new CapsuleGeometry(0.028, 0.36, 8, 16), body), 0.1, 0.22);
  part('humerus-l', new Mesh(new CapsuleGeometry(0.03, 0.3, 8, 16), body), -0.27, 1.32, 0, 0.12);
  part('humerus-r', new Mesh(new CapsuleGeometry(0.03, 0.3, 8, 16), body), 0.27, 1.32, 0, -0.12);

  // Ribcage: stacked rings read as a torso at a glance.
  for (let i = 0; i < 6; i++) {
    const ring = new Mesh(new TorusGeometry(0.14 - i * 0.006, 0.012, 8, 40), body);
    ring.name = `rib-${i}`;
    ring.position.set(0, 1.4 - i * 0.05, 0);
    ring.rotation.x = Math.PI / 2;
    root.add(ring);
  }

  // Soft ground halo so the figure feels anchored in the void.
  const halo = new Mesh(
    new RingGeometry(0.28, 0.3, 64),
    new MeshBasicMaterial({
      color: surface.glassEdge,
      transparent: true,
      opacity: 0.6,
      side: DoubleSide,
    }),
  );
  halo.name = 'halo';
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.002;
  root.add(halo);

  return root;
}
