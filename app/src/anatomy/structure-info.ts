/**
 * Curated descriptive text per structure. Separate from the registry (what a
 * structure IS and where it sits) so reviewed content can change on its own.
 * This is educational anatomy only: no diagnosis, medication or dosing.
 */
import type { AnatomyRegistry } from './registry.js';

export interface InfoDoc {
  schema: number;
  reviewStatus: 'unreviewed' | 'reviewed';
  note: string;
  entries: Record<string, string>;
  prefixes: Record<string, string>;
}

export interface StructureInfo {
  title: string;
  /** e.g. "Respiratory system" */
  systemName: string;
  /** e.g. "Part of: Right lung" */
  partOf: string;
  summary: string;
  approximate: boolean;
  /** Always-visible warning shown on the card, or null. */
  notice: string | null;
  reviewStatus: InfoDoc['reviewStatus'];
}

export const APPROXIMATE_NOTICE =
  'Illustrative volume generated from airway and vessel geometry. Not an actual lung surface. Not for clinical reasoning.';

export async function loadStructureInfo(url: string): Promise<InfoDoc> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Structure info ${url}: HTTP ${response.status}`);
  return (await response.json()) as InfoDoc;
}

export function describeStructure(registry: AnatomyRegistry, doc: InfoDoc, id: string): StructureInfo | null {
  const def = registry.get(id);
  if (!def) return null;
  const parent = def.parent ? registry.get(def.parent) : undefined;
  let summary = doc.entries[id];
  if (!summary) {
    const prefix = Object.keys(doc.prefixes).find((p) => id.startsWith(p));
    summary = prefix ? doc.prefixes[prefix] : `${def.name}.`;
  }
  if (def.approximate) {
    summary += ' Shape shown is an approximate envelope generated from airway and vessel geometry, not a segmented lung surface.';
  }
  return {
    title: def.name,
    systemName: registry.doc.systems[def.system]?.name ?? def.system,
    partOf: parent ? `Part of: ${parent.name}` : '',
    summary,
    approximate: !!def.approximate,
    notice: def.approximate ? APPROXIMATE_NOTICE : null,
    reviewStatus: doc.reviewStatus,
  };
}
