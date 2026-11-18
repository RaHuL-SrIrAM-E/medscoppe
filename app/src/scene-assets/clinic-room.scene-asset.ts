import { BoxGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry } from '@iwsdk/core';

/**
 * MOCK consulting room (placeholder for the real clinic, which will arrive as passthrough on a headset). Procedural
 * boxes only, so it needs no asset licence. Origin is the floor at the room's centre line; the room extends from
 * z=+1.8 (behind the viewer) to z=-4.2, x=+-3, 2.8 m tall. The middle of the room is left clear for the anatomy.
 */
const W = 6;
const H = 2.8;
const Z_FRONT = 1.8;
const Z_BACK = -4.2;
const D = Z_FRONT - Z_BACK;
const ZC = (Z_FRONT + Z_BACK) / 2;

const std = (color: number, roughness = 0.85, metalness = 0): MeshStandardMaterial => new MeshStandardMaterial({ color, roughness, metalness });

function box(parent: Group, name: string, size: [number, number, number], pos: [number, number, number], material: MeshStandardMaterial | MeshBasicMaterial): Mesh {
  const mesh = new Mesh(new BoxGeometry(...size), material);
  mesh.name = name;
  mesh.position.set(...pos);
  parent.add(mesh);
  return mesh;
}

function plane(parent: Group, name: string, size: [number, number], pos: [number, number, number], rotY: number, material: MeshStandardMaterial): void {
  const mesh = new Mesh(new PlaneGeometry(...size), material);
  mesh.name = name;
  mesh.position.set(...pos);
  mesh.rotation.y = rotY;
  parent.add(mesh);
}

export function createClinicRoom(): Group {
  const root = new Group();
  root.name = 'clinic-room';

  const wall = std(0x5f7782);
  const accentWall = std(0x2c4650);
  const floor = std(0x66737a, 0.55);
  const ceiling = std(0x8a9aa2);
  const wood = std(0xb88a5a, 0.7);
  const white = std(0xf4f6f7, 0.6);
  const steel = std(0x9aa5ab, 0.35, 0.6);
  const teal = std(0x3f8f8b, 0.7);
  const dark = std(0x23292e, 0.5);
  const glow = new MeshBasicMaterial({ color: 0xffffff });
  const sky = new MeshBasicMaterial({ color: 0x9cc4dc });
  wall.side = accentWall.side = floor.side = ceiling.side = DoubleSide;

  // shell
  plane(root, 'floor', [W, D], [0, 0, ZC], 0, floor);
  root.children[0]!.rotation.set(-Math.PI / 2, 0, 0);
  const ceil = new Mesh(new PlaneGeometry(W, D), ceiling);
  ceil.name = 'ceiling';
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, H, ZC);
  root.add(ceil);
  plane(root, 'wall-back', [W, H], [0, H / 2, Z_BACK], 0, accentWall);
  plane(root, 'wall-front', [W, H], [0, H / 2, Z_FRONT], Math.PI, wall);
  plane(root, 'wall-left', [D, H], [-W / 2, H / 2, ZC], Math.PI / 2, wall);
  plane(root, 'wall-right', [D, H], [W / 2, H / 2, ZC], -Math.PI / 2, wall);
  box(root, 'skirting-back', [W, 0.1, 0.02], [0, 0.05, Z_BACK + 0.01], white);

  // ceiling light panels
  for (const x of [-1.4, 1.4]) for (const z of [-3, -0.6]) box(root, 'ceiling-light', [1.0, 0.04, 0.5], [x, H - 0.02, z], glow);

  // window on the back wall, with a sill and blinds line
  box(root, 'window-sky', [1.8, 1.1, 0.02], [0.9, 1.65, Z_BACK + 0.02], sky);
  for (const [name, size, pos] of [
    ['window-frame-top', [1.9, 0.06, 0.05], [0.9, 2.22, Z_BACK + 0.03]],
    ['window-frame-bottom', [1.9, 0.06, 0.05], [0.9, 1.08, Z_BACK + 0.03]],
    ['window-frame-left', [0.06, 1.2, 0.05], [-0.02, 1.65, Z_BACK + 0.03]],
    ['window-frame-right', [0.06, 1.2, 0.05], [1.82, 1.65, Z_BACK + 0.03]],
    ['window-frame-mid', [0.04, 1.1, 0.05], [0.9, 1.65, Z_BACK + 0.03]],
  ] as Array<[string, [number, number, number], [number, number, number]]>) box(root, name, size, pos, white);
  box(root, 'window-sill', [2.0, 0.04, 0.18], [0.9, 1.04, Z_BACK + 0.1], white);

  // desk, monitor and chair (back left)
  const dx = -1.9;
  const dz = -3.4;
  box(root, 'desk-top', [1.5, 0.05, 0.75], [dx, 0.75, dz], wood);
  for (const [lx, lz] of [[-0.7, -0.33], [0.7, -0.33], [-0.7, 0.33], [0.7, 0.33]]) box(root, 'desk-leg', [0.05, 0.75, 0.05], [dx + lx, 0.375, dz + lz], steel);
  box(root, 'desk-drawers', [0.4, 0.5, 0.65], [dx + 0.5, 0.45, dz], white);
  box(root, 'monitor-screen', [0.55, 0.33, 0.02], [dx - 0.2, 1.1, dz - 0.15], dark);
  box(root, 'monitor-stand', [0.05, 0.22, 0.04], [dx - 0.2, 0.89, dz - 0.15], steel);
  box(root, 'keyboard', [0.4, 0.015, 0.14], [dx - 0.2, 0.78, dz + 0.1], dark);
  const chair = new Group();
  chair.name = 'doctor-chair';
  chair.position.set(dx - 0.2, 0, dz + 0.95);
  box(chair, 'seat', [0.46, 0.06, 0.46], [0, 0.48, 0], dark);
  box(chair, 'back', [0.44, 0.5, 0.06], [0, 0.82, 0.22], dark);
  const post = new Mesh(new CylinderGeometry(0.03, 0.03, 0.42, 12), steel);
  post.position.set(0, 0.24, 0);
  chair.add(post);
  const base = new Mesh(new CylinderGeometry(0.25, 0.25, 0.03, 16), steel);
  base.position.set(0, 0.03, 0);
  chair.add(base);
  chair.rotation.y = Math.PI * 0.85;
  root.add(chair);

  // examination couch (back right)
  const cx = 1.9;
  const cz = -2.5;
  box(root, 'couch-frame', [0.7, 0.5, 1.9], [cx, 0.25, cz], steel);
  box(root, 'couch-pad', [0.7, 0.1, 1.9], [cx, 0.55, cz], teal);
  box(root, 'couch-pillow', [0.5, 0.08, 0.3], [cx, 0.64, cz - 0.7], white);
  box(root, 'couch-paper', [0.62, 0.005, 1.7], [cx, 0.608, cz + 0.05], white);
  const stool = new Mesh(new CylinderGeometry(0.17, 0.17, 0.05, 16), dark);
  stool.position.set(cx - 0.9, 0.45, cz + 0.4);
  stool.name = 'stool-seat';
  root.add(stool);
  const stoolLeg = new Mesh(new CylinderGeometry(0.025, 0.025, 0.43, 8), steel);
  stoolLeg.position.set(cx - 0.9, 0.22, cz + 0.4);
  root.add(stoolLeg);

  // wall cabinet with a counter and a sink (right wall)
  const rx = W / 2 - 0.3;
  box(root, 'counter-base', [0.55, 0.85, 1.6], [rx, 0.425, -0.6], white);
  box(root, 'counter-top', [0.6, 0.04, 1.65], [rx, 0.87, -0.6], wood);
  box(root, 'wall-cabinet', [0.35, 0.7, 1.4], [W / 2 - 0.18, 1.85, -0.6], white);
  box(root, 'sink', [0.4, 0.02, 0.4], [rx, 0.9, -0.3], steel);
  box(root, 'sanitiser', [0.08, 0.2, 0.08], [W / 2 - 0.1, 1.2, -1.2], teal);

  // door (left wall), anatomy poster and a medical cross sign (back wall)
  box(root, 'door', [0.04, 2.05, 0.95], [-W / 2 + 0.03, 1.025, -0.3], wood);
  box(root, 'door-handle', [0.04, 0.04, 0.14], [-W / 2 + 0.07, 1.0, -0.7], steel);
  box(root, 'poster', [0.7, 0.95, 0.015], [-0.9, 1.6, Z_BACK + 0.01], white);
  box(root, 'poster-image', [0.58, 0.8, 0.005], [-0.9, 1.6, Z_BACK + 0.02], teal);
  box(root, 'cross-bar-h', [0.28, 0.08, 0.01], [-2.0, 2.05, Z_BACK + 0.01], teal);
  box(root, 'cross-bar-v', [0.08, 0.28, 0.01], [-2.0, 2.05, Z_BACK + 0.01], teal);

  // a plant for warmth
  const pot = new Mesh(new CylinderGeometry(0.14, 0.11, 0.3, 16), white);
  pot.position.set(-2.7, 0.15, -1.6);
  root.add(pot);
  box(root, 'plant', [0.22, 0.5, 0.22], [-2.7, 0.55, -1.6], std(0x4f8f56));

  return root;
}
