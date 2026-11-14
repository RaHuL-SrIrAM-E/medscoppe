/**
 * MEDSCOPE design tokens. Pure data: no Three.js, no DOM, so it is safe to
 * import from the asset manifest, systems and (later) the backend-facing UI.
 */

/** Signature hue per anatomical system (sRGB hex). */
export const systemColors = {
  skeletal: 0xe9e2d0, // bone ivory
  muscular: 0xe0675a, // muscle coral
  respiratory: 0x4cc9e6, // respiratory cyan
  nervous: 0xf2c14e, // nervous gold
  surface: 0x9fb4c8, // body shell, cool steel
} as const;

export type AnatomicalSystemId = keyof typeof systemColors;

export const anatomicalSystemIds = Object.keys(
  systemColors,
) as AnatomicalSystemId[];

/** One accent for clinical emphasis (selected hypothesis, active structure). */
export const accent = 0x7cf2d4;

export const surface = {
  void: 0x05080d,
  glass: 0x0e1622,
  glassEdge: 0x2a3b52,
} as const;

/** Motion durations in seconds and a shared easing. Nothing pops in instantly. */
export const motion = {
  fast: 0.25,
  base: 0.4,
  slow: 0.7,
  /** Exponential smoothing rate for per-frame lerps (higher = snappier). */
  smoothing: 6,
} as const;

/** Layout distances in meters, measured from the viewer. */
export const depth = {
  anatomy: 1.3,
  labels: 1.15,
  ribbon: 0.9,
} as const;
