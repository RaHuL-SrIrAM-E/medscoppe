import { intentBus } from '../core/intents.js';
import { anatomicalSystemIds } from '../design/tokens.js';

/**
 * Development-only input path: keys 1-4 switch anatomical system. It emits the
 * same intents the hand and voice adapters will, proving the shared pipeline.
 * Real hand interaction remains mandatory for the shipped experience.
 */
export function installDesktopAdapter(): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
    const index = Number(event.key) - 1;
    const system = anatomicalSystemIds[index];
    if (system) {
      intentBus.emit({ type: 'SET_ANATOMICAL_SYSTEM', system }, 'desktop');
    }
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
