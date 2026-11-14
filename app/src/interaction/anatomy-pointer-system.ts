import { createSystem, type Entity, Quaternion, Vector3 } from '@iwsdk/core';
import { intentBus, type IntentSource } from '../core/intents.js';
import { AnatomyRoot } from '../anatomy/anatomy-component.js';

const TAP_MAX_MS = 600;
const ROTATE_THRESHOLD_RAD = (4 * Math.PI) / 180;
/** Model yaw per radian of hand-ray sweep. >1 so a small arm motion spins it. */
const SWEEP_GAIN = 2;
const SMOOTHING = 14;
const IGNORED = new Set(['halo']);

type RayHit = { pointerPosition?: { x: number; y: number; z: number } };
type PointerLike = {
  object?: { name?: string };
  pointerType?: string;
  intersection?: RayHit;
};
type Spinnable = {
  rotation: { y: number };
  addEventListener: (type: string, cb: (e: PointerLike) => void) => void;
  removeEventListener: (type: string, cb: (e: PointerLike) => void) => void;
};
type RaySpace = {
  getWorldPosition: (target: Vector3) => Vector3;
  getWorldQuaternion: (target: Quaternion) => Quaternion;
};

/**
 * Turns pinch/ray pointer events on the anatomy into intents.
 *  - quick pinch (or click) on a structure       -> SELECT_STRUCTURE
 *  - pinch, hold and sweep the hand sideways     -> ROTATE_MODEL start/end
 * The turntable rotation is applied here (yaw only), not by IWSDK's
 * DistanceGrabbable, so the model stays upright and the mapping is predictable.
 */
export class AnatomyPointerSystem extends createSystem({
  roots: { required: [AnatomyRoot] },
}) {
  private target: Spinnable | null = null;
  private pressed = false;
  private rotating = false;
  private pressStart = 0;
  private pressStructure = '';
  private source: IntentSource = 'hand';
  private space: RaySpace | null = null;
  private hand: 'left' | 'right' | null = null;
  private releaseListener: ((e: { inputSource: { handedness: string } }) => void) | null = null;
  private rayYaw0 = 0;
  private modelYaw0 = 0;
  private desiredYaw = 0;

  private tmpPos!: Vector3;
  private tmpFwd!: Vector3;
  private tmpQuat!: Quaternion;

  init(): void {
    this.tmpPos = new Vector3();
    this.tmpFwd = new Vector3();
    this.tmpQuat = new Quaternion();
    for (const entity of this.queries.roots.entities) this.bind(entity);
    this.cleanupFuncs.push(
      this.queries.roots.subscribe('qualify', (entity) => this.bind(entity)),
    );
  }

  /** Horizontal aim angle of a ray space; increases as the ray sweeps right. */
  private aimAngle(space: RaySpace): number {
    space.getWorldQuaternion(this.tmpQuat);
    this.tmpFwd.set(0, 0, -1).applyQuaternion(this.tmpQuat);
    return Math.atan2(this.tmpFwd.x, -this.tmpFwd.z);
  }

  /** The ray space (left/right hand) whose origin is nearest the pointer origin. */
  private nearestSpace(hit: RayHit | undefined): RaySpace | null {
    const origin = hit?.pointerPosition;
    if (!origin) return null;
    let best: RaySpace | null = null;
    let bestDistance = Infinity;
    for (const hand of ['left', 'right'] as const) {
      const space = this.player.raySpaces[hand] as unknown as RaySpace;
      space.getWorldPosition(this.tmpPos);
      const d = this.tmpPos.distanceToSquared(origin as Vector3);
      if (d < bestDistance) {
        bestDistance = d;
        best = space;
        this.hand = hand;
      }
    }
    return best;
  }

  /**
   * A sweeping ray leaves the (thin) model, so the pointer may never deliver
   * `pointerup` to it. The XR session's `selectend` for the pressing hand is the
   * reliable end-of-pinch signal.
   */
  private listenForRelease(release: () => void): void {
    this.stopListeningForRelease();
    const session = this.renderer.xr.getSession();
    if (!session) return;
    const listener = (e: { inputSource: { handedness: string } }): void => {
      if (e.inputSource.handedness === this.hand) release();
    };
    this.releaseListener = listener;
    session.addEventListener('selectend', listener as never);
  }

  private stopListeningForRelease(): void {
    if (!this.releaseListener) return;
    this.renderer.xr
      .getSession()
      ?.removeEventListener('selectend', this.releaseListener as never);
    this.releaseListener = null;
  }

  private bind(entity: Entity): void {
    const object = entity.object3D as unknown as Spinnable | null;
    if (!object) return;
    this.target = object;

    const down = (e: PointerLike): void => {
      this.pressed = true;
      this.rotating = false;
      this.pressStart = performance.now();
      this.pressStructure = e.object?.name ?? '';
      this.source = e.pointerType === 'mouse' ? 'desktop' : 'hand';
      this.space = this.source === 'hand' ? this.nearestSpace(e.intersection) : null;
      this.modelYaw0 = object.rotation.y;
      this.desiredYaw = object.rotation.y;
      if (this.space) {
        this.rayYaw0 = this.aimAngle(this.space);
        this.listenForRelease(up);
      }
    };
    const up = (): void => {
      if (!this.pressed) return;
      this.pressed = false;
      this.space = null;
      this.stopListeningForRelease();
      if (this.rotating) {
        this.rotating = false;
        const yawDegrees = ((object.rotation.y - this.modelYaw0) * 180) / Math.PI;
        intentBus.emit({ type: 'ROTATE_MODEL', phase: 'end', yawDegrees }, this.source);
      } else if (
        performance.now() - this.pressStart < TAP_MAX_MS &&
        this.pressStructure &&
        !IGNORED.has(this.pressStructure)
      ) {
        intentBus.emit(
          { type: 'SELECT_STRUCTURE', structureId: this.pressStructure },
          this.source,
        );
      }
    };

    object.addEventListener('pointerdown', down);
    object.addEventListener('pointerup', up);
    object.addEventListener('pointercancel', up);
    this.cleanupFuncs.push(() => {
      object.removeEventListener('pointerdown', down);
      object.removeEventListener('pointerup', up);
      object.removeEventListener('pointercancel', up);
    });
  }

  update(delta: number): void {
    if (!this.pressed || !this.space || !this.target) return;
    // Wrap to (-PI, PI] so crossing the +/-180 seam never causes a jump.
    const raw = this.aimAngle(this.space) - this.rayYaw0;
    const sweep = Math.atan2(Math.sin(raw), Math.cos(raw));
    this.desiredYaw = this.modelYaw0 + sweep * SWEEP_GAIN;

    if (!this.rotating) {
      if (Math.abs(this.desiredYaw - this.modelYaw0) < ROTATE_THRESHOLD_RAD) return;
      this.rotating = true;
      intentBus.emit({ type: 'ROTATE_MODEL', phase: 'start' }, this.source);
    }
    const k = 1 - Math.exp(-SMOOTHING * delta);
    this.target.rotation.y += (this.desiredYaw - this.target.rotation.y) * k;
  }
}
