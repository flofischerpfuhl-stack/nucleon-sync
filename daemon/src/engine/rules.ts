// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Selection rule matcher (docs/SYNC-RULES.md).
 *
 * Inputs: user prefix rules (folder tree checkboxes), user/default name globs (junk + dev caches) and built-in
 * dev-cache heuristics (Unity `Library` next to `Assets`+`ProjectSettings`; `build`/`target`/`.build` next to a build
 * marker — cheap heuristics for build and cache folders). Hard exclusions (absolute local paths) always win.
 *
 * Precedence: the most specific (deepest) decision wins; on equal depth a user prefix rule beats a glob, and a
 * user rule beats a default rule. So `include 03_Projects/X/node_modules` re-enables one cache folder.
 */
import { HARD_EXCLUDED_LOCAL_PATHS, type SelectionRule } from '@nucleon-sync/shared';

export const BUILD_MARKERS = new Set([
  'pubspec.yaml',
  'build.gradle',
  'build.gradle.kts',
  'package.json',
  'CMakeLists.txt',
  'pom.xml',
  'settings.gradle',
  'Cargo.toml',
]);

export type ExcludedBy = 'user' | 'default' | 'hard' | 'pair';

export interface MatchResult {
  excluded: boolean;
  by: ExcludedBy | null;
  /** depth (number of path segments) at which the deciding rule matched; 0 = nothing matched */
  depth: number;
}

const INCLUDED: MatchResult = { excluded: false, by: null, depth: 0 };

/** Minimal glob: `*` any run, `?` one char; whole-name match, case-sensitive (Linux). */
export function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (const c of glob) {
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$', 's');
}

interface CompiledGlob {
  re: RegExp;
  kind: 'include' | 'exclude';
  source: 'user' | 'default';
}

export interface RuleMatcherOptions {
  rules: SelectionRule[];
  /** absolute local root of the pair (for hard exclusions); omit for remote-only matching */
  localRoot?: string;
  hardExcluded?: string[];
  /** built-in heuristics (Unity Library, build/target next to markers); default true */
  heuristics?: boolean;
  /** nested pairs: sub folders (rel paths) owned by another pair — always excluded, like hard exclusions */
  ownedPaths?: string[];
}

export class RuleMatcher {
  private readonly prefixes: { path: string; depth: number; kind: 'include' | 'exclude'; source: 'user' | 'default' }[];
  private readonly globs: CompiledGlob[];
  private readonly hardRel: string[];
  private readonly hardWholeRoot: boolean;
  private readonly heuristics: boolean;
  private readonly owned: string[];

  constructor(o: RuleMatcherOptions) {
    this.prefixes = o.rules
      .filter((r) => r.patternType === 'prefix')
      .map((r) => {
        const p = normRel(r.pattern);
        return { path: p, depth: p ? p.split('/').length : 0, kind: r.kind, source: r.source };
      })
      .sort((a, b) => b.depth - a.depth);
    this.globs = o.rules
      .filter((r) => r.patternType === 'glob')
      .map((r) => ({ re: globToRegExp(r.pattern), kind: r.kind, source: r.source }));
    this.heuristics = o.heuristics ?? true;
    this.owned = (o.ownedPaths ?? []).map(normRel).filter(Boolean);
    const hard = [...HARD_EXCLUDED_LOCAL_PATHS, ...(o.hardExcluded ?? [])].map((p) => p.replace(/\/+$/, ''));
    const root = o.localRoot?.replace(/\/+$/, '');
    this.hardRel = [];
    this.hardWholeRoot = false;
    if (root) {
      for (const h of hard) {
        if (root === h || root.startsWith(h + '/')) this.hardWholeRoot = true;
        else if (h.startsWith(root + '/')) this.hardRel.push(h.slice(root.length + 1));
      }
    }
  }

  /**
   * @param relPath '/'-separated path relative to the pair root
   * @param siblingsOf returns the names in a folder (rel path) — needed for the heuristics; optional
   */
  match(relPath: string, siblingsOf?: (folderRel: string) => Set<string> | undefined): MatchResult {
    if (this.hardWholeRoot) return { excluded: true, by: 'hard', depth: 0 };
    const rel = normRel(relPath);
    for (const h of this.hardRel)
      if (rel === h || rel.startsWith(h + '/')) return { excluded: true, by: 'hard', depth: 0 };
    for (const p of this.owned)
      if (rel === p || rel.startsWith(p + '/')) return { excluded: true, by: 'pair', depth: p.split('/').length };
    const segs = rel ? rel.split('/') : [];

    // deepest prefix rule
    let prefix: (typeof this.prefixes)[number] | undefined;
    for (const p of this.prefixes) {
      if (p.depth === 0 || rel === p.path || rel.startsWith(p.path + '/')) {
        prefix = p;
        break;
      }
    }
    // deepest glob/heuristic exclusion and deepest glob inclusion
    let globEx: { depth: number; source: 'user' | 'default' } | null = null;
    let globIn: { depth: number; source: 'user' | 'default' } | null = null;
    for (let i = 0; i < segs.length; i++) {
      const name = segs[i]!;
      for (const g of this.globs) {
        if (!g.re.test(name)) continue;
        if (g.kind === 'exclude') globEx = { depth: i + 1, source: g.source };
        if (g.kind === 'include') globIn = { depth: i + 1, source: g.source };
      }
      if (
        globEx?.depth !== i + 1 &&
        this.heuristics &&
        (name === 'Library' || name === 'build' || name === 'target' || name === '.build')
      ) {
        const parent = segs.slice(0, i).join('/');
        const sib = siblingsOf?.(parent);
        if (sib && heuristicExcludes(name, sib)) globEx = { depth: i + 1, source: 'default' };
      }
    }

    const candidates: { excluded: boolean; by: ExcludedBy | null; depth: number; rank: number }[] = [];
    if (prefix)
      candidates.push({
        excluded: prefix.kind === 'exclude',
        by: prefix.kind === 'exclude' ? prefix.source : null,
        depth: prefix.depth,
        rank: prefix.source === 'user' ? 3 : 2,
      });
    if (globEx)
      candidates.push({
        excluded: true,
        by: globEx.source,
        depth: globEx.depth,
        rank: globEx.source === 'user' ? 1 : 0,
      });
    if (globIn)
      candidates.push({ excluded: false, by: null, depth: globIn.depth, rank: globIn.source === 'user' ? 1 : 0 });
    if (!candidates.length) return INCLUDED;
    candidates.sort((a, b) => b.depth - a.depth || b.rank - a.rank);
    const c = candidates[0]!;
    return { excluded: c.excluded, by: c.excluded ? c.by : null, depth: c.depth };
  }

  /** True if some user prefix rule lies strictly below relPath (tree shows "partial"). */
  hasRulesBelow(relPath: string): boolean {
    const rel = normRel(relPath);
    return this.prefixes.some((p) => p.depth > 0 && (rel === '' ? true : p.path.startsWith(rel + '/')));
  }
}

export function heuristicExcludes(name: string, siblings: Set<string>): boolean {
  if (name === 'Library') return siblings.has('Assets') && siblings.has('ProjectSettings');
  if (name === 'build' || name === 'target' || name === '.build') {
    for (const m of BUILD_MARKERS) if (siblings.has(m)) return true;
  }
  return false;
}

export function normRel(p: string): string {
  return p
    .normalize('NFC')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}
