/**
 * Anatomy view state and its reducer. Pure TypeScript: it knows nothing about
 * meshes, hands or voice. Input systems emit intents; this module turns them
 * into state; the render system turns state into pixels.
 */
import type { Intent } from '../core/intents.js';
import type { AnatomyRegistry } from './registry.js';

export type SystemMode = 'active' | 'ghost' | 'hidden';

export interface AnatomyState {
  systemModes: Record<string, SystemMode>;
  selectedId: string | null;
  hoverId: string | null;
  isolatedId: string | null;
  infoOpen: boolean;
}

const CONTEXT_SURFACE = 'surface';

export function initialState(registry: AnatomyRegistry): AnatomyState {
  const systemModes: Record<string, SystemMode> = {};
  for (const system of registry.systemsWithGeometry()) {
    systemModes[system] = system === CONTEXT_SURFACE ? 'hidden' : 'ghost';
  }
  // Default framing: respiratory in focus, the skeleton as translucent context.
  if ('respiratory' in systemModes) systemModes.respiratory = 'active';
  return { systemModes, selectedId: null, hoverId: null, isolatedId: null, infoOpen: false };
}

export function reduce(state: AnatomyState, intent: Intent, registry: AnatomyRegistry): AnatomyState {
  switch (intent.type) {
    case 'SET_ANATOMICAL_SYSTEM': {
      const system = intent.system;
      if (!(system in state.systemModes)) return state; // not loaded (e.g. muscular)
      if (system === CONTEXT_SURFACE) {
        const next = state.systemModes[system] === 'hidden' ? 'ghost' : 'hidden';
        return { ...state, systemModes: { ...state.systemModes, [system]: next } };
      }
      const systemModes = { ...state.systemModes };
      for (const key of Object.keys(systemModes)) {
        if (key === CONTEXT_SURFACE) continue;
        systemModes[key] = key === system ? 'active' : 'ghost';
      }
      return { ...state, systemModes, isolatedId: null, selectedId: null, infoOpen: false };
    }
    case 'TOGGLE_SYSTEM_VISIBILITY': {
      const mode = state.systemModes[intent.system];
      if (!mode) return state;
      const next: SystemMode = mode === 'hidden' ? (intent.system === CONTEXT_SURFACE ? 'ghost' : 'active') : 'hidden';
      return { ...state, systemModes: { ...state.systemModes, [intent.system]: next } };
    }
    case 'SELECT_STRUCTURE': {
      if (!registry.has(intent.structureId)) return state;
      if (state.selectedId === intent.structureId) {
        return { ...state, selectedId: null, infoOpen: false }; // pinching again deselects
      }
      return { ...state, selectedId: intent.structureId, infoOpen: false };
    }
    case 'CLEAR_SELECTION':
      return { ...state, selectedId: null, infoOpen: false };
    case 'HOVER_STRUCTURE':
      return state.hoverId === intent.structureId ? state : { ...state, hoverId: intent.structureId };
    case 'SHOW_CLINICAL_INFORMATION':
      if (!registry.has(intent.structureId)) return state;
      return { ...state, selectedId: intent.structureId, infoOpen: true };
    case 'HIDE_CLINICAL_INFORMATION':
      return { ...state, infoOpen: false };
    case 'ISOLATE_STRUCTURE':
      if (!registry.has(intent.structureId)) return state;
      return { ...state, isolatedId: intent.structureId, selectedId: intent.structureId };
    case 'CLEAR_ISOLATION':
      return { ...state, isolatedId: null };
    case 'RESET_VIEW':
      return initialState(registry);
    default:
      return state;
  }
}

export interface Visual {
  visible: boolean;
  opacity: number;
  /** 0 none, up to 1 for the selected structure. */
  emphasis: number;
  /** Only pickable structures are raycast, so ghosts never block the ray. */
  pickable: boolean;
}

const HIDDEN: Visual = { visible: false, opacity: 0, emphasis: 0, pickable: false };
const GHOST_OPACITY = 0.1;
/** Lung envelopes and the diaphragm are translucent so the airways and vessels inside stay visible. */
const SHELL_OPACITY = 0.32;

export function deriveVisual(state: AnatomyState, registry: AnatomyRegistry, id: string): Visual {
  const def = registry.get(id);
  if (!def) return HIDDEN;
  const emphasis = id === state.selectedId ? 1 : id === state.hoverId ? 0.4 : 0;

  if (state.isolatedId) {
    if (!registry.isWithin(id, state.isolatedId)) return HIDDEN;
    return { visible: true, opacity: 1, emphasis, pickable: true };
  }
  const mode = state.systemModes[def.system] ?? 'hidden';
  if (mode === 'hidden') return HIDDEN;
  if (mode === 'ghost' || def.system === CONTEXT_SURFACE) {
    return { visible: true, opacity: def.system === CONTEXT_SURFACE ? 0.07 : GHOST_OPACITY, emphasis: 0, pickable: false };
  }
  const isShell = id.startsWith('respiratory.lung.') || id === 'respiratory.diaphragm';
  return { visible: true, opacity: isShell && emphasis < 1 ? SHELL_OPACITY : 1, emphasis, pickable: true };
}

type Listener = (state: AnatomyState, previous: AnatomyState) => void;

class AnatomyStore {
  private registry: AnatomyRegistry | null = null;
  private current: AnatomyState | null = null;
  private listeners = new Set<Listener>();

  init(registry: AnatomyRegistry): void {
    this.registry = registry;
    this.current = initialState(registry);
  }

  get ready(): boolean {
    return this.registry !== null;
  }

  getRegistry(): AnatomyRegistry {
    if (!this.registry) throw new Error('Anatomy store used before init');
    return this.registry;
  }

  get(): AnatomyState {
    if (!this.current) throw new Error('Anatomy store used before init');
    return this.current;
  }

  dispatch(intent: Intent): void {
    if (!this.registry || !this.current) return;
    const previous = this.current;
    const next = reduce(previous, intent, this.registry);
    if (next === previous) return;
    this.current = next;
    for (const listener of this.listeners) listener(next, previous);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const anatomyStore = new AnatomyStore();
