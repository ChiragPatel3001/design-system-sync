/**
 * Impact-analysis helpers built on the component-dependency graph that
 * snapshot.ts preserves from registry.json. Pure graph traversal only —
 * no judgment about severity or whether a change "matters".
 *
 * ChangeRecord.affectedComponents (see compare.ts) is intentionally only
 * the one-hop, directly-known impact. The functions here let a caller
 * (today: a human via the CLI's printed summary; later: the Claude-based
 * sync agent) deterministically expand that into the full transitive
 * graph on demand, without baking a "how far should this expand" opinion
 * into the change record itself.
 */
import type { Snapshot } from './types.ts';

/** Component ids that directly consume `tokenId`, per the token's own consumedBy list. */
export function directTokenConsumers(snapshot: Snapshot, tokenId: string): string[] {
  const token = snapshot.tokens.find((t) => t.tokenId === tokenId);
  return token ? [...token.consumedBy].sort() : [];
}

/** Components whose dependsOnComponents list directly names `componentId`. */
export function oneHopUsedBy(snapshot: Snapshot, componentId: string): string[] {
  return snapshot.components
    .filter((c) => c.dependsOnComponents.some((d) => d.id === componentId))
    .map((c) => c.id)
    .sort();
}

/**
 * Breadth-first expansion from a set of seed component ids, walking both
 * directions of the component dependency graph (what each component
 * depends on, and what depends on each component) until no new component
 * is reached. Deterministic and order-independent (return value is always
 * sorted) — this is graph traversal, not inference.
 */
export function expandImpact(snapshot: Snapshot, seedComponentIds: string[]): string[] {
  const byId = new Map(snapshot.components.map((c) => [c.id, c]));
  const visited = new Set<string>(seedComponentIds.filter((id) => byId.has(id)));
  const queue = [...visited];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    const component = byId.get(id);
    const neighbors = [
      ...(component?.dependsOnComponents.map((d) => d.id) ?? []),
      ...oneHopUsedBy(snapshot, id),
    ];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return [...visited].sort();
}
