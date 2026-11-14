/**
 * Time abstraction. Everything in the consultation pipeline that waits (scripted replay timing, batching quiet
 * windows, extraction retries) goes through a Scheduler, so tests run deterministically on virtual time.
 */
export type Cancel = () => void;

export interface Scheduler {
  /** Monotonic milliseconds. */
  now(): number;
  schedule(delayMs: number, fn: () => void): Cancel;
}

export const realScheduler: Scheduler = {
  now: () => performance.now(),
  schedule(delayMs, fn) {
    const handle = setTimeout(fn, Math.max(0, delayMs));
    return () => clearTimeout(handle);
  },
};
