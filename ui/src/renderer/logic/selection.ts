// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Folder selection (docs/SYNC-RULES.md): tri-state tree state + pending changes -> SelectionRule[] for
 * PUT /v1/pairs/:id/rules. Pure functions, unit-tested.
 *
 * Model: user rules are relPath prefix rules (`include`/`exclude`); the longest matching prefix wins, default is
 * "included". Default excludes are name globs evaluated by the daemon; including a default-excluded folder needs
 * an explicit include rule ("force").
 */
import type { SelectionRule, TreeNodeDto } from '@nucleon-sync/shared';

export type Sel = 'included' | 'excluded' | 'partial';
export interface Change {
  value: 'include' | 'exclude';
  /** always write an explicit rule (node excluded by a default glob) */
  force: boolean;
}
export type Changes = ReadonlyMap<string, Change>;
export type NodeLike = Pick<TreeNodeDto, 'relPath' | 'selection' | 'excludedBy'>;

export const isDescendant = (ancestor: string, p: string) => ancestor === '' || p.startsWith(ancestor + '/');
const depth = (p: string) => (p === '' ? 0 : p.split('/').length);

function nearestAncestorChange(changes: Changes, relPath: string): Change | null {
  let best: [string, Change] | null = null;
  for (const [p, c] of changes)
    if (p !== relPath && isDescendant(p, relPath) && (!best || p.length > best[0].length)) best = [p, c];
  return best ? best[1] : null;
}

/** never selectable: hard exclusions and sub folders owned by a nested pair */
const fixedExcluded = (node: NodeLike) => node.excludedBy === 'hard' || node.excludedBy === 'pair';

export function effectiveSelection(node: NodeLike, changes: Changes): Sel {
  if (fixedExcluded(node)) return 'excluded';
  const own = changes.get(node.relPath);
  let base: Sel;
  if (own) base = own.value === 'include' ? 'included' : 'excluded';
  else {
    const anc = nearestAncestorChange(changes, node.relPath);
    if (anc) base = anc.value === 'exclude' || node.excludedBy === 'default' ? 'excluded' : 'included';
    else base = node.selection;
  }
  if (base === 'partial') return base;
  for (const [p, c] of changes) {
    if (p === node.relPath || !isDescendant(node.relPath, p)) continue;
    if ((c.value === 'include') !== (base === 'included')) return 'partial';
  }
  return base;
}

/** Click on a checkbox: excluded -> include, included/partial -> exclude. Overrides all changes below the node. */
export function toggle(changes: Changes, node: NodeLike): Map<string, Change> {
  const next = new Map(changes);
  if (fixedExcluded(node)) return next;
  const value: Change['value'] = effectiveSelection(node, changes) === 'excluded' ? 'include' : 'exclude';
  for (const p of [...next.keys()]) if (p === node.relPath || isDescendant(node.relPath, p)) next.delete(p);
  const without = effectiveSelection(node, next);
  const redundant = without === (value === 'include' ? 'included' : 'excluded') && node.excludedBy !== 'default';
  if (!redundant) next.set(node.relPath, { value, force: node.excludedBy === 'default' });
  return next;
}

function longestPrefixRule(rules: SelectionRule[], relPath: string): SelectionRule | null {
  let best: SelectionRule | null = null;
  for (const r of rules)
    if (r.patternType === 'prefix' && (r.pattern === relPath || isDescendant(r.pattern, relPath)))
      if (!best || r.pattern.length > best.pattern.length) best = r;
  return best;
}

/** Merge pending changes into the pair's current user rules (minimal rule set, parents processed first). */
export function applyChanges(base: SelectionRule[], changes: Changes): SelectionRule[] {
  const keep = base.filter((r) => !(r.source === 'user' && r.patternType === 'prefix'));
  let prefix = base
    .filter((r) => r.source === 'user' && r.patternType === 'prefix')
    .map((r) => ({ kind: r.kind, patternType: r.patternType, pattern: r.pattern, source: r.source }) as SelectionRule);
  const ordered = [...changes.entries()].sort((a, b) => depth(a[0]) - depth(b[0]) || a[0].localeCompare(b[0]));
  for (const [p, c] of ordered) {
    prefix = prefix.filter((r) => r.pattern !== p && !isDescendant(p, r.pattern));
    const inherited = longestPrefixRule(prefix, p)?.kind ?? 'include';
    if (inherited !== c.value || c.force)
      prefix.push({ kind: c.value, patternType: 'prefix', pattern: p, source: 'user' });
  }
  prefix.sort((a, b) => a.pattern.localeCompare(b.pattern));
  return [...keep, ...prefix];
}

/**
 * Fallback when the daemon offers no GET for the rules: reconstruct user prefix rules from the tree nodes loaded so
 * far (only loaded subtrees are known; see CHANGELOG-).
 */
export function rulesFromTree(nodes: Iterable<NodeLike>): SelectionRule[] {
  const all = [...nodes].sort((a, b) => depth(a.relPath) - depth(b.relPath));
  const rules: SelectionRule[] = [];
  for (const n of all) {
    if (n.excludedBy === 'hard' || n.excludedBy === 'default') continue;
    const inherited = longestPrefixRule(rules, n.relPath)?.kind ?? 'include';
    if (n.selection === 'excluded' && n.excludedBy === 'user' && inherited !== 'exclude')
      rules.push({ kind: 'exclude', patternType: 'prefix', pattern: n.relPath, source: 'user' });
    else if (n.selection === 'included' && inherited === 'exclude')
      rules.push({ kind: 'include', patternType: 'prefix', pattern: n.relPath, source: 'user' });
  }
  return rules;
}

export function summarizeChanges(changes: Changes): { excluded: number; included: number } {
  let excluded = 0;
  let included = 0;
  for (const c of changes.values()) {
    if (c.value === 'exclude') excluded++;
    else included++;
  }
  return { excluded, included };
}
