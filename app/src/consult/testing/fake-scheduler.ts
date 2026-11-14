import type { Cancel, Scheduler } from '../core/scheduler.js';

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Virtual time for deterministic tests. ``advance`` runs due timers in order and lets promises settle between them. */
export class FakeScheduler implements Scheduler {
  private t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }

  schedule(delayMs: number, fn: () => void): Cancel {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, delayMs), fn });
    return () => {
      this.timers.delete(id);
    };
  }

  get pending(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await flushMicrotasks();
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (timer.at < nextAt || (timer.at === nextAt && id < nextId))) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId < 0) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.t = Math.max(this.t, timer.at);
      timer.fn();
      await flushMicrotasks();
    }
    this.t = target;
    await flushMicrotasks();
  }

  /** Run every timer, however far in the future, until none remain (bounded, to catch runaway loops). */
  async runAll(limit = 100000): Promise<void> {
    for (let i = 0; i < limit && this.timers.size > 0; i++) {
      const next = Math.min(...[...this.timers.values()].map((x) => x.at));
      await this.advance(Math.max(0, next - this.t));
    }
    await flushMicrotasks();
  }
}
