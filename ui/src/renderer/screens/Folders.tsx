// SPDX-License-Identifier: GPL-3.0-or-later
/** docs/SYNC-RULES.md Ordner & Auswahl: pair header, lazy tri-state tree, global excludes, pending changes bar, pair wizard. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PairDto, SelectionRule, TreeNodeDto } from '@nucleon-sync/shared';

import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { Button, Checkbox, Empty, PauseControl, Pill, Spinner, Switch } from '../components/ui.tsx';
import { toApiError } from '../errors.ts';
import { fmtBytes } from '../format.ts';
import { KEY_EVENTS, rowKeys } from '../components/a11y.ts';
import { t } from '../i18n/index.ts';
import {
  applyChanges,
  effectiveSelection,
  rulesFromTree,
  summarizeChanges,
  toggle,
  type Change,
} from '../logic/selection.ts';
import { asArray, normalizeSettings } from '../logic/normalize.ts';
import { remoteCheckText } from '../logic/status.ts';
import { DEFAULT_SETTINGS, TWO_WAY_DEFAULTS } from '../shared.ts';
import { askChoice, setLeaveGuard, toast, toastError, useApi, useStore, withConfirm } from '../store.ts';
import { PairWizard } from './PairWizard.tsx';

/** Unapplied selection changes of the visible pair (reported by PairPanel). */
export interface UnsavedChanges {
  summary: string;
  apply: () => Promise<boolean>;
  discard: () => void;
}

/**
 * Asks what to do with unapplied selection changes before they would be lost (new pair, other pair, other screen).
 * Resolves true when the caller may continue (applied or discarded), false to stay.
 */
export async function resolveUnsaved(u: UnsavedChanges | null): Promise<boolean> {
  if (!u) return true;
  const choice = await askChoice({
    title: t.unsaved.title,
    body: t.unsaved.body(u.summary),
    options: [
      { id: 'stay', label: t.unsaved.stay },
      { id: 'discard', label: t.unsaved.discard },
      { id: 'apply', label: t.unsaved.apply, variant: 'primary' },
    ],
  });
  if (choice === 'apply') return u.apply();
  if (choice === 'discard') {
    u.discard();
    return true;
  }
  return false;
}

export function Folders() {
  const status = useStore((s) => s.status);
  const pairs = status?.pairs ?? [];
  const [pairId, setPairId] = useState<number | null>(null);
  const [wizard, setWizard] = useState(false);
  const unsaved = useRef<UnsavedChanges | null>(null);
  const pair = pairs.find((p) => p.id === pairId) ?? pairs.find((p) => p.enabled) ?? pairs[0];
  useEffect(() => {
    if (pair && pair.id !== pairId) setPairId(pair.id);
  }, [pair, pairId]);
  // leaving the screen (sidebar, links) asks as well
  useEffect(() => {
    setLeaveGuard(() => resolveUnsaved(unsaved.current));
    return () => setLeaveGuard(null);
  }, []);
  const onUnsaved = useCallback((u: UnsavedChanges | null) => {
    unsaved.current = u;
  }, []);
  const openWizard = async () => {
    if (await resolveUnsaved(unsaved.current)) setWizard(true);
  };
  const switchPair = async (id: number) => {
    if (await resolveUnsaved(unsaved.current)) setPairId(id);
  };
  // `n` (app.tsx): new pair
  const openRef = useRef(openWizard);
  openRef.current = openWizard;
  useEffect(() => {
    const h = () => void openRef.current();
    window.addEventListener(KEY_EVENTS.newPair, h);
    return () => window.removeEventListener(KEY_EVENTS.newPair, h);
  }, []);
  if (wizard) return <PairWizard onDone={() => setWizard(false)} />;
  if (!status) return <Empty icon="sync">{t.shell.connecting}</Empty>;
  const accName = (id: string) => status.accounts.find((a) => a.id === id)?.displayName ?? id;
  return (
    <div className="folders-screen">
      <div className="toolbar">
        <label className="field-inline">
          <span>{t.folders.pair}</span>
          <select
            value={pair?.id ?? ''}
            onChange={(e) => void switchPair(Number(e.target.value))}
            data-testid="pair-select"
          >
            {pairs.map((p) => (
              <option key={p.id} value={p.id}>
                {accName(p.accountId)} · {p.name}
                {p.enabled ? '' : ` (${t.pair.disabled})`}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <Button icon="plus" onClick={() => void openWizard()} data-testid="add-pair">
          {t.folders.addPair.replace('+ ', '')}
        </Button>
      </div>
      {pair ? (
        <PairPanel key={pair.id} pair={pair} onUnsaved={onUnsaved} />
      ) : (
        <Empty icon="folder">{t.folders.noPairs}</Empty>
      )}
    </div>
  );
}

function PairPanel({ pair, onUnsaved }: { pair: PairDto; onUnsaved: (u: UnsavedChanges | null) => void }) {
  const online = useStore((s) => s.connection === 'connected');
  const [children, setChildren] = useState<Map<string, TreeNodeDto[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  const [changes, setChanges] = useState<Map<string, Change>>(new Map());
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  const rules = useApi(() => api.rules(pair.id), [pair.id, version]);

  const loadPath = useCallback(
    async (path: string) => {
      setLoadingPaths((s) => new Set(s).add(path));
      try {
        const nodes = asArray(await api.tree(pair.id, path));
        setChildren((m) => new Map(m).set(path, nodes));
        setTreeError(null);
      } catch (e) {
        const err = toApiError(e);
        setTreeError(err.notImplemented ? t.folders.treeUnavailable : err.message);
      } finally {
        setLoadingPaths((s) => {
          const n = new Set(s);
          n.delete(path);
          return n;
        });
      }
    },
    [pair.id],
  );

  useEffect(() => {
    setChildren(new Map());
    void loadPath('');
    for (const p of expanded) void loadPath(p);
    // expanded intentionally not a dependency: only reload on version change
    // (re-expanding loads lazily via toggleExpand)
  }, [loadPath, version]);

  const toggleExpand = (n: TreeNodeDto) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(n.relPath)) next.delete(n.relPath);
      else {
        next.add(n.relPath);
        if (!children.has(n.relPath)) void loadPath(n.relPath);
      }
      return next;
    });
  };

  const visible = useMemo(() => {
    const out: { node: TreeNodeDto; depth: number }[] = [];
    const walk = (path: string, depth: number) => {
      for (const node of children.get(path) ?? []) {
        out.push({ node, depth });
        if (expanded.has(node.relPath)) walk(node.relPath, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }, [children, expanded]);

  const apply = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const allNodes = [...children.values()].flat();
      const base: SelectionRule[] = Array.isArray(rules.data) ? rules.data : rulesFromTree(allNodes);
      await api.setRules(pair.id, applyChanges(base, changes));
      setChanges(new Map());
      setVersion((v) => v + 1);
      toast('ok', t.folders.applied);
      return true;
    } catch (e) {
      toastError(e);
      return false;
    } finally {
      setSaving(false);
    }
  };

  // a direction change of a pair with synced files asks first (409 confirm round-trip)
  const patch = (p: Partial<PairDto>) => void withConfirm((tok) => api.patchPair(pair.id, p, tok)).catch(toastError);
  const [name, setName] = useState(pair.name);
  useEffect(() => setName(pair.name), [pair.name]);
  const rename = () => {
    const v = name.trim();
    if (!v || v === pair.name) return setName(pair.name);
    void api
      .patchPair(pair.id, { name: v })
      .then(() => toast('ok', t.folders.renamed))
      .catch(toastError);
  };
  const removePair = async () => {
    try {
      if ((await withConfirm((tok) => api.removePair(pair.id, tok))) !== null) toast('ok', t.folders.removed);
    } catch (e) {
      toastError(e);
    }
  };
  const sum = summarizeChanges(changes);

  // report unapplied changes to the screen (new pair / other pair / leaving asks first)
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    onUnsaved(
      changes.size
        ? {
            summary: t.folders.changes(sum.excluded, sum.included),
            apply: () => applyRef.current(),
            discard: () => setChanges(new Map()),
          }
        : null,
    );
  }, [changes, sum.excluded, sum.included, onUnsaved]);
  useEffect(() => () => onUnsaved(null), [onUnsaved]);

  return (
    <>
      <section className="card pair-head">
        <div className="pair-paths">
          <span className="mono">{pair.localRoot}</span>
          <Icon
            name={
              pair.direction === 'backup'
                ? 'move'
                : pair.direction === 'mirror-down'
                  ? 'mirror'
                  : pair.direction === 'two-way'
                    ? 'twoWay'
                    : 'outbox'
            }
            size={18}
          />
          <span className="mono">{pair.remoteRoot}</span>
        </div>
        <div className="pair-controls">
          <label className="field-inline">
            <span>{t.folders.direction}</span>
            <select
              value={pair.direction}
              disabled={!online}
              onChange={(e) => patch({ direction: e.target.value as PairDto['direction'] })}
            >
              {(Object.keys(t.pair.direction) as PairDto['direction'][]).map((d) => (
                <option key={d} value={d}>
                  {t.pair.direction[d]}
                </option>
              ))}
            </select>
          </label>
          <label className="field-inline">
            <span>{t.folders.enabled}</span>
            <Switch checked={pair.enabled} onChange={(v) => patch({ enabled: v })} label={t.folders.enabled} />
          </label>
          {pair.direction === 'mirror-down' ? (
            <label className="field-inline" title={t.folders.uploadLocalNewHelp} data-testid="upload-local-new">
              <span>{t.folders.uploadLocalNew}</span>
              <Switch
                checked={!!pair.options?.uploadLocalNew}
                onChange={(v) => patch({ options: { uploadLocalNew: v } })}
                label={t.folders.uploadLocalNew}
              />
            </label>
          ) : null}
          <PauseControl small paused={pair.paused} disabled={!online} target={{ scope: 'pair', id: pair.id }} />
          <Button
            small
            icon="sync"
            disabled={!online || !pair.enabled}
            onClick={() => void api.sync({ pairId: pair.id }).catch(toastError)}
          >
            {t.actions.sync}
          </Button>
        </div>
        <details className="pair-settings" data-testid="pair-settings">
          <summary>{t.folders.pairSettings}</summary>
          <div className="pair-extra">
            <label className="field-inline">
              <span>{t.folders.name}</span>
              <input
                value={name}
                maxLength={80}
                disabled={!online}
                onChange={(e) => setName(e.target.value)}
                onBlur={rename}
                onKeyDown={(e) => e.key === 'Enter' && rename()}
                data-testid="pair-name"
              />
            </label>
            {pair.direction === 'backup' ? (
              <>
                <label className="field-inline">
                  <span>{t.folders.remoteChanges}</span>
                  <select
                    value={pair.options?.remoteChanges ?? 'download'}
                    disabled={!online}
                    onChange={(e) => patch({ options: { remoteChanges: e.target.value as 'download' | 'conflict' } })}
                  >
                    {(['download', 'conflict'] as const).map((o) => (
                      <option key={o} value={o}>
                        {t.folders.remoteChangesOpt[o]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-inline">
                  <span>{t.folders.remoteDeletions}</span>
                  <select
                    value={pair.options?.remoteDeletions ?? 'reupload'}
                    disabled={!online}
                    onChange={(e) => patch({ options: { remoteDeletions: e.target.value as 'reupload' | 'ask' } })}
                  >
                    {(['reupload', 'ask'] as const).map((o) => (
                      <option key={o} value={o}>
                        {t.folders.remoteDeletionsOpt[o]}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
            {pair.direction === 'two-way' ? <TwoWayOptions pair={pair} online={online} /> : null}
            <span className="spacer" />
            <Button
              small
              icon="sync"
              title={t.folders.fullCheckHint}
              disabled={!online || !pair.enabled}
              onClick={() => void api.sync({ pairId: pair.id, mode: 'full' }).catch(toastError)}
            >
              {t.folders.fullCheck}
            </Button>
            <Button small variant="danger" icon="trash" disabled={!online} onClick={() => void removePair()}>
              {t.folders.removePair}
            </Button>
          </div>
        </details>
      </section>

      {pair.direction === 'two-way' || pair.ownedElsewhere?.length ? (
        <div className="muted small pair-notes" data-testid="pair-notes">
          {remoteCheckText(pair) ? <span>{remoteCheckText(pair)}</span> : null}
          {(pair.ownedElsewhere ?? []).map((o) => (
            <span key={o.pairId}>{t.pair.ownedElsewhere(o.relPath, o.pairName)}</span>
          ))}
        </div>
      ) : null}
      <section className="card tree-card">
        <div className="thead tree-grid">
          <span>{t.folders.col.name}</span>
          <span className="num">{t.folders.col.local}</span>
          <span className="num">{t.folders.col.remote}</span>
          <span>{t.folders.col.status}</span>
        </div>
        <div
          className="tree-body"
          data-testid="tree"
          aria-label={t.folders.col.name}
          onKeyDown={(e) =>
            rowKeys(e, {
              row: '.tree-row',
              target: '[role=checkbox]',
              expand: (row) => row.querySelector<HTMLButtonElement>('.tree-chev[aria-expanded=false]')?.click(),
              collapse: (row) => row.querySelector<HTMLButtonElement>('.tree-chev[aria-expanded=true]')?.click(),
            })
          }
        >
          {treeError ? <Empty icon="info">{treeError}</Empty> : null}
          {!treeError && loadingPaths.has('') && !children.has('') ? (
            <div className="loading-line">
              <Spinner /> {t.folders.loading}
            </div>
          ) : null}
          {visible.map(({ node, depth }) => (
            <TreeRow
              key={node.relPath}
              node={node}
              depth={depth}
              sel={effectiveSelection(node, changes)}
              changed={changes.has(node.relPath)}
              expanded={expanded.has(node.relPath)}
              loading={loadingPaths.has(node.relPath)}
              onExpand={() => toggleExpand(node)}
              onToggle={() => setChanges((c) => toggle(c, node))}
            />
          ))}
        </div>
      </section>

      <GlobalExcludes />

      {changes.size ? (
        <div className="changes-bar" data-testid="changes-bar">
          <Icon name="info" size={18} />
          <span>
            {t.folders.changes(sum.excluded, sum.included)}
            {sum.excluded ? <span className="muted"> · {t.folders.excludeNote}</span> : null}
          </span>
          <span className="spacer" />
          <Button onClick={() => setChanges(new Map())}>{t.actions.discard}</Button>
          <Button variant="primary" busy={saving} onClick={() => void apply()}>
            {t.actions.apply}
          </Button>
        </div>
      ) : null}
      {!rules.loading && rules.error && changes.size ? (
        <div className="muted small">{t.folders.rulesFallback}</div>
      ) : null}
    </>
  );
}

/** two-way pairs: remote check interval and the mass-delete guard thresholds (saved on blur / Enter) */
function TwoWayOptions({ pair, online }: { pair: PairDto; online: boolean }) {
  const fields = [
    ['remoteCheckMinutes', t.folders.remoteCheckMinutes, 1, 1440],
    ['massDeleteMaxFiles', t.folders.massDeleteMaxFiles, 0, 1_000_000],
    ['massDeletePercent', t.folders.massDeletePercent, 0, 100],
  ] as const;
  const current = (k: (typeof fields)[number][0]) => String(pair.options?.[k] ?? TWO_WAY_DEFAULTS[k]);
  const [vals, setVals] = useState(() => Object.fromEntries(fields.map(([k]) => [k, current(k)])));
  useEffect(
    () => setVals(Object.fromEntries(fields.map(([k]) => [k, current(k)]))),
    [pair.id, pair.options?.remoteCheckMinutes, pair.options?.massDeleteMaxFiles, pair.options?.massDeletePercent],
  );
  const save = (k: (typeof fields)[number][0], min: number, max: number) => {
    const n = Number(vals[k]);
    if (!Number.isInteger(n) || n < min || n > max || String(n) === current(k))
      return setVals((v) => ({ ...v, [k]: current(k) }));
    void api
      .patchPair(pair.id, { options: { [k]: n } })
      .then(() => toast('ok', t.folders.optionSaved))
      .catch((e: unknown) => {
        setVals((v) => ({ ...v, [k]: current(k) }));
        toastError(e);
      });
  };
  return (
    <>
      {fields.map(([k, label, min, max]) => (
        <label
          key={k}
          className="field-inline"
          title={k === 'remoteCheckMinutes' ? undefined : t.folders.massDeleteHint}
        >
          <span>{label}</span>
          <input
            type="number"
            style={{ width: 90 }}
            min={min}
            max={max}
            value={vals[k]}
            disabled={!online}
            onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))}
            onBlur={() => save(k, min, max)}
            onKeyDown={(e) => e.key === 'Enter' && save(k, min, max)}
            data-testid={`pair-opt-${k}`}
          />
        </label>
      ))}
    </>
  );
}

function stateText(node: TreeNodeDto, sel: string): { text: string; tone: string } {
  const s = node.states;
  if (node.excludedBy === 'hard') return { text: `– ${t.folders.hardExcluded}`, tone: 'muted' };
  if (node.excludedBy === 'pair') return { text: `– ${t.folders.ownedByPair}`, tone: 'muted' };
  if (sel === 'excluded')
    return {
      text: node.excludedBy === 'user' ? `– ${t.folders.userExcluded}` : `– ${t.folders.notSynced}`,
      tone: 'muted',
    };
  if (s.conflict) return { text: `⚠ ${t.pair.conflicts(s.conflict)}`, tone: 'warn' };
  if (s.error) return { text: `✕ ${t.pair.errors(s.error)}`, tone: 'err' };
  const up = (s.local_new ?? 0) + (s.local_changed ?? 0) + (s.moved ?? 0);
  if (up) return { text: `↑ ${t.pair.pending(up)}`, tone: 'info' };
  const down = (s.remote_new ?? 0) + (s.remote_changed ?? 0);
  if (down) return { text: `↓ ${t.pair.newRemote(down)}`, tone: 'info' };
  if (node.localBytes === null) return { text: `☁ ${t.folders.remoteOnly}`, tone: 'info' };
  return { text: `✓ ${t.pair.upToDate}`, tone: 'ok' };
}

function TreeRow({
  node,
  depth,
  sel,
  changed,
  expanded,
  loading,
  onExpand,
  onToggle,
}: {
  node: TreeNodeDto;
  depth: number;
  sel: 'included' | 'excluded' | 'partial';
  changed: boolean;
  expanded: boolean;
  loading: boolean;
  onExpand: () => void;
  onToggle: () => void;
}) {
  const st = stateText(node, sel);
  return (
    <div
      className={`tree-row tree-grid${sel === 'excluded' ? ' dim' : ''}${changed ? ' changed' : ''}`}
      data-path={node.relPath}
    >
      <span className="tree-name" style={{ paddingLeft: depth * 26 }}>
        {node.hasChildren ? (
          <button
            type="button"
            className="icon-btn tree-chev"
            onClick={onExpand}
            aria-label={node.name}
            aria-expanded={expanded}
          >
            {loading ? <Spinner /> : <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={16} />}
          </button>
        ) : (
          <span className="tree-chev" />
        )}
        <Checkbox
          state={sel}
          onChange={onToggle}
          disabled={node.excludedBy === 'hard' || node.excludedBy === 'pair'}
          label={node.name}
        />
        <Icon
          name={node.kind === 'file' ? 'file' : node.localBytes === null ? 'folderCloud' : 'folder'}
          size={20}
          className="tree-icon"
        />
        <span className="ellipsis" title={node.relPath}>
          {node.name}
        </span>
        {node.excludedBy === 'default' ? <Pill tone="muted">{t.folders.defaultExcluded}</Pill> : null}
        {node.excludedBy === 'hard' ? <Pill tone="err">{t.folders.hardExcluded}</Pill> : null}
        {node.excludedBy === 'pair' ? <Pill tone="info">{t.folders.ownedByPair}</Pill> : null}
      </span>
      <span className="num">{node.localBytes === null ? '–' : fmtBytes(node.localBytes)}</span>
      <span className="num">{node.remoteBytes === null ? '–' : fmtBytes(node.remoteBytes)}</span>
      <span
        className={`tone-${st.tone} ellipsis`}
        title={node.localFiles !== null ? t.storage.files(node.localFiles) : undefined}
      >
        {st.text}
      </span>
    </div>
  );
}

function GlobalExcludes() {
  const settings = useApi(async () => normalizeSettings(await api.settings(), DEFAULT_SETTINGS), []);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const list = (settings.data?.globalExcludes ?? DEFAULT_SETTINGS.globalExcludes).map((r) => r.pattern);
  const save = async () => {
    const patterns = [
      ...new Set(
        text
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    const old = settings.data?.globalExcludes ?? DEFAULT_SETTINGS.globalExcludes;
    const globalExcludes: SelectionRule[] = patterns.map(
      (pattern) =>
        old.find((r) => r.pattern === pattern) ?? { kind: 'exclude', patternType: 'glob', pattern, source: 'user' },
    );
    try {
      await api.putSettings({ globalExcludes });
      setEditing(false);
      settings.reload();
      toast('ok', t.settings.saved);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <section className="card excludes">
      <div className="excludes-line">
        <b>{t.folders.globalExcludes}:</b>
        <span className="mono ellipsis">{list.join('  ')}</span>
        {!editing ? (
          <Button
            small
            variant="ghost"
            onClick={() => {
              setText(list.join('\n'));
              setEditing(true);
            }}
          >
            {t.actions.edit}
          </Button>
        ) : null}
      </div>
      {editing ? (
        <div className="excludes-edit">
          <div className="muted small">{t.folders.excludesHint}</div>
          <textarea
            value={text}
            rows={8}
            onChange={(e) => setText(e.target.value)}
            aria-label={t.folders.editExcludes}
          />
          <div className="row-end">
            <Button onClick={() => setEditing(false)}>{t.actions.cancel}</Button>
            <Button variant="primary" onClick={() => void save()}>
              {t.actions.save}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
