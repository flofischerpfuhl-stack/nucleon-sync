// SPDX-License-Identifier: GPL-3.0-or-later
/** docs/SYNC-RULES.md Konflikte & Löschungen: conflict cards, pending deletions (grouped, bulk), adoption proposals. */
import { useEffect, useMemo, useState } from 'react';

import type {
  AdoptionProposalDto,
  ConflictDto,
  ConflictResolution,
  DeletionDecision,
  FileSnapshot,
  PairDto,
  PendingDeletionDto,
} from '@nucleon-sync/shared';

import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { AccountChips, Button, Checkbox, Chips, Empty, Pill } from '../components/ui.tsx';
import { fmtBytes, fmtDateTime } from '../format.ts';
import { section, t } from '../i18n/index.ts';
import { groupDeletions, type SortKey } from '../logic/deletions.ts';
import { asArray } from '../logic/normalize.ts';
import { toast, toastError, useApi, useStore, withConfirm } from '../store.ts';

type Tab = 'conflicts' | 'deletions' | 'adoptions';
const I = section('issues');

export function Issues() {
  const status = useStore((s) => s.status);
  const [tab, setTab] = useState<Tab>('conflicts');
  const [account, setAccount] = useState<string | null>(null);
  const conflicts = useApi(() => api.conflicts(), [], ['conflicts_changed', 'run']);
  const deletions = useApi(() => api.deletions(), [], ['deletions_changed', 'run']);
  const adoptions = useApi(() => api.adoptions(), [], ['run']);
  const pairs = status?.pairs ?? [];
  const accounts = status?.accounts ?? [];
  const byAcc = <T extends { accountId: string }>(l: T[] | null) =>
    asArray(l).filter((x) => !account || x.accountId === account);
  const c = byAcc(conflicts.data);
  const d = byAcc(deletions.data);
  const a = byAcc(adoptions.data);
  const pairOf = (id: number) => pairs.find((p) => p.id === id);
  const accName = (id: string) => accounts.find((x) => x.id === id)?.displayName ?? id;
  return (
    <div className="stack">
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {(
            [
              ['conflicts', I.tabConflicts, c.length],
              ['deletions', I.tabDeletions, d.length],
              ['adoptions', I.tabAdoptions, a.length],
            ] as [Tab, string, number][]
          ).map(([id, label, n]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`tab${tab === id ? ' on' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
              <span className={`count${n ? ' has' : ''}`}>{n}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <AccountChips accounts={accounts} value={account} onChange={setAccount} />
      </div>
      {tab === 'conflicts' ? <Conflicts list={c} pairOf={pairOf} accName={accName} reload={conflicts.reload} /> : null}
      {tab === 'deletions' ? <Deletions list={d} pairOf={pairOf} reload={deletions.reload} /> : null}
      {tab === 'adoptions' ? <Adoptions list={a} reload={adoptions.reload} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ conflicts

function Snap({ label, s, highlight }: { label: string; s: FileSnapshot | null; highlight?: boolean }) {
  return (
    <div className={`snap${highlight ? ' newer' : ''}`}>
      <div className="snap-label">{label}</div>
      {s ? (
        <>
          <div className="snap-main">
            {fmtBytes(s.size)} · {fmtDateTime(s.mtime)}
          </div>
          <div className="snap-sha mono muted">{s.sha1 ? `sha1 ${s.sha1.slice(0, 8)}…` : 'sha1 –'}</div>
        </>
      ) : (
        <div className="muted">{I.missing}</div>
      )}
    </div>
  );
}

function Conflicts({
  list,
  pairOf,
  accName,
  reload,
}: {
  list: ConflictDto[];
  pairOf: (id: number) => PairDto | undefined;
  accName: (id: string) => string;
  reload: () => void;
}) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const resolve = async (ids: number[], r: ConflictResolution) => {
    setBusy(true);
    try {
      let cancelled = false;
      for (const id of ids) {
        if ((await withConfirm((t) => api.resolveConflict(id, r, t))) === null) {
          cancelled = true;
          break;
        }
      }
      setSel(new Set());
      if (!cancelled) toast('ok', I.done);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      reload();
    }
  };
  if (!list.length) return <Empty icon="check">{I.noConflicts}</Empty>;
  return (
    <>
      {sel.size ? (
        <div className="bulk-bar">
          <span>{I.selectionConflicts(sel.size)}</span>
          <span className="spacer" />
          <Button busy={busy} onClick={() => void resolve([...sel], 'keep_local')}>
            {I.keepLocal}
          </Button>
          <Button busy={busy} onClick={() => void resolve([...sel], 'keep_remote')}>
            {I.keepRemote}
          </Button>
          <Button busy={busy} onClick={() => void resolve([...sel], 'keep_both')}>
            {I.keepBoth}
          </Button>
        </div>
      ) : null}
      <div className="stack-sm">
        {list.map((c) => {
          const pair = pairOf(c.pairId);
          const lNewer = c.local && c.remote ? c.local.mtime > c.remote.mtime : false;
          const abs = (rel: string) => (pair ? `${pair.localRoot.replace(/\/+$/, '')}/${rel}` : null);
          const open = (...rels: (string | null | undefined)[]) => {
            for (const r of rels) {
              const a = r ? abs(r) : null;
              if (a) void window.nucleonSync.openPath(a);
            }
          };
          const review = c.keptBoth ?? null;
          const copy = review?.copyRelPath ?? null;
          const note = review
            ? copy
              ? I.keptBothCopy(copy)
              : c.kind === 'remote_changed_local_deleted'
                ? I.restoredLocal
                : I.restoredRemote
            : c.kind === 'needs_check'
              ? I.needsCheckHint
              : null;
          // restored after "deleted here, changed there": which resolution carries out the deletion after all
          const deleteAfterAll: ConflictResolution =
            c.kind === 'remote_changed_local_deleted' ? 'keep_local' : 'keep_remote';
          return (
            <section key={c.id} className="card conflict" data-testid={`conflict-${c.id}`}>
              <div className="conflict-head">
                <Checkbox
                  state={sel.has(c.id)}
                  label={c.relPath}
                  onChange={() =>
                    setSel((s) => {
                      const n = new Set(s);
                      if (n.has(c.id)) n.delete(c.id);
                      else n.add(c.id);
                      return n;
                    })
                  }
                />
                <Icon name={review ? 'info' : 'warn'} size={20} className={review ? 'tone-info' : 'tone-warn'} />
                <div className="conflict-title">
                  <div>
                    <b>{I.conflictTitle}:</b> {I.kind[c.kind]} · {accName(c.accountId)}
                    {review ? (
                      <>
                        {' '}
                        <Pill tone="info">{I.keptBoth}</Pill>
                      </>
                    ) : null}
                  </div>
                  <div className="mono break">
                    {pair ? `${pair.name}/` : ''}
                    {c.relPath}
                  </div>
                </div>
                <span className="muted small">{fmtDateTime(c.detectedAt)}</span>
              </div>
              {note ? (
                <div className="muted conflict-note" data-testid={`conflict-note-${c.id}`}>
                  {note}
                </div>
              ) : null}
              <div className="snaps">
                <Snap
                  label={copy ? `${I.local} (${copy.slice(copy.lastIndexOf('/') + 1)})` : I.local}
                  s={c.local}
                  highlight={lNewer}
                />
                <Snap label={I.remote} s={c.remote} highlight={!lNewer && !!c.remote} />
                <Snap label={I.base} s={c.base} />
              </div>
              {review && copy ? (
                <div className="conflict-actions">
                  <Button icon="external" onClick={() => open(c.relPath, copy)} data-testid={`open-both-${c.id}`}>
                    {I.openBoth}
                  </Button>
                  <Button busy={busy} onClick={() => void resolve([c.id], 'keep_local')}>
                    {I.reviewKeepLocal}
                  </Button>
                  <Button busy={busy} onClick={() => void resolve([c.id], 'keep_remote')}>
                    {I.reviewKeepRemote}
                  </Button>
                  <Button variant="primary" busy={busy} onClick={() => void resolve([c.id], 'keep_both')}>
                    {I.reviewKeepBoth}
                  </Button>
                </div>
              ) : review ? (
                <div className="conflict-actions">
                  <Button icon="external" onClick={() => open(c.relPath)}>
                    {I.open}
                  </Button>
                  <Button busy={busy} onClick={() => void resolve([c.id], deleteAfterAll)}>
                    {I.reviewDelete}
                  </Button>
                  <Button variant="primary" busy={busy} onClick={() => void resolve([c.id], 'keep_both')}>
                    {I.reviewKeep}
                  </Button>
                </div>
              ) : (
                <div className="conflict-actions">
                  {c.direction === 'two-way' && c.local ? (
                    <Button icon="external" onClick={() => open(c.relPath)}>
                      {I.open}
                    </Button>
                  ) : null}
                  <Button busy={busy} onClick={() => void resolve([c.id], 'keep_local')}>
                    {I.keepLocal}
                  </Button>
                  <Button busy={busy} onClick={() => void resolve([c.id], 'keep_remote')}>
                    {I.keepRemote}
                  </Button>
                  <Button busy={busy} title={I.keepBothHint} onClick={() => void resolve([c.id], 'keep_both')}>
                    {I.keepBoth}
                  </Button>
                  <Button variant="ghost" busy={busy} onClick={() => void resolve([c.id], 'ignore')}>
                    {I.ignore}
                  </Button>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ deletions

function Deletions({
  list,
  pairOf,
  reload,
}: {
  list: PendingDeletionDto[];
  pairOf: (id: number) => PairDto | undefined;
  reload: () => void;
}) {
  const [sort, setSort] = useState<SortKey>('path');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => groupDeletions(list, pairOf, sort), [list, pairOf, sort]);
  // default selection: everything without the "changed in Proton after deletion" warning
  const listKey = list.map((d) => d.id).join(',');
  useEffect(() => {
    // two-way: one side at a time (deleted here vs. deleted in Proton need different decisions)
    const side = list.some((d) => (d.side ?? 'local') === 'local') ? 'local' : 'remote';
    setSel(new Set(list.filter((d) => !d.remoteChangedSinceDelete && (d.side ?? 'local') === side).map((d) => d.id)));
  }, [listKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSel(new Set(list.map((d) => d.id)));
      } else if (e.key === 'Escape') setSel(new Set());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [list]);
  const selRows = list.filter((d) => sel.has(d.id));
  const selBytes = selRows.reduce((s, d) => s + d.size, 0);
  // two-way: files deleted in Proton (side 'remote') get other decisions than files deleted here
  const sides = new Set(selRows.map((d) => d.side ?? 'local'));
  const mixed = sides.size > 1;
  const remoteSide = !mixed && sides.has('remote');
  const held = list.filter((d) => d.held);
  const heldPairs = [...new Set(held.map((d) => d.pairId))];
  const decideHeld = async (pairId: number, approve: boolean) => {
    setBusy(true);
    try {
      const r = await withConfirm((t) => api.decideHeld(pairId, approve, t));
      if (r) toast('ok', approve ? I.heldApproved : I.heldDenied);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      reload();
    }
  };
  const decide = async (decision: DeletionDecision) => {
    setBusy(true);
    try {
      const ids = selRows.map((d) => d.id);
      const r = await withConfirm((t) => api.decideDeletions({ ids, decision }, t));
      if (r) toast('ok', I.done);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      reload();
    }
  };
  const toggleIds = (ids: number[], on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      for (const id of ids)
        if (on) n.add(id);
        else n.delete(id);
      return n;
    });
  if (!list.length) return <Empty icon="check">{I.noDeletions}</Empty>;
  return (
    <>
      {heldPairs.map((pid) => {
        const rows = held.filter((d) => d.pairId === pid);
        const remote = rows.filter((d) => d.side === 'remote').length;
        return (
          <section
            key={pid}
            className="card held-card"
            role="region"
            aria-labelledby={`held-title-${pid}`}
            data-testid={`held-${pid}`}
          >
            <div className="row">
              <Icon name="warn" size={20} className="tone-warn" />
              <b id={`held-title-${pid}`}>{I.heldTitle(pairOf(pid)?.name ?? `#${pid}`, rows.length)}</b>
            </div>
            <div className="muted">{I.heldIntro}</div>
            <ul className="held-sides">
              {rows.length - remote ? <li>{I.heldLocal(rows.length - remote)}</li> : null}
              {remote ? <li>{I.heldRemote(remote)}</li> : null}
            </ul>
            {/* the safe choice comes first in the tab order; approving opens the confirm dialog (Cancel focused) */}
            <div className="conflict-actions">
              <Button busy={busy} onClick={() => void decideHeld(pid, false)} data-testid={`held-deny-${pid}`}>
                {I.heldDeny}
              </Button>
              <Button
                variant="danger"
                icon="trash"
                busy={busy}
                onClick={() => void decideHeld(pid, true)}
                data-testid={`held-approve-${pid}`}
              >
                {I.heldApprove}
              </Button>
            </div>
          </section>
        );
      })}
      <div className="row">
        <span className="muted">{I.deletionsIntro}</span>
        <span className="spacer" />
        <span className="muted small">{I.shortcuts}</span>
        <Chips<SortKey>
          label={I.sortBy}
          options={(['path', 'size', 'date'] as SortKey[]).map((k) => ({ value: k, label: I.sort[k] }))}
          value={sort}
          onChange={setSort}
        />
      </div>
      <section className="card del-list" data-testid="deletions">
        {groups.map((g) => {
          const ids = g.rows.map((r) => r.id);
          const n = ids.filter((id) => sel.has(id)).length;
          const st = n === 0 ? 'excluded' : n === ids.length ? 'included' : 'partial';
          const bytes = g.rows.reduce((s, r) => s + r.size, 0);
          if (g.folder !== null) {
            const isOpen = open.has(g.key);
            return (
              <div key={g.key} className="del-group">
                <div className="del-row">
                  <Checkbox state={st} label={g.folder} onChange={() => toggleIds(ids, st !== 'included')} />
                  <button
                    type="button"
                    className="icon-btn"
                    aria-expanded={isOpen}
                    aria-label={g.folder}
                    onClick={() =>
                      setOpen((o) => {
                        const x = new Set(o);
                        if (x.has(g.key)) x.delete(g.key);
                        else x.add(g.key);
                        return x;
                      })
                    }
                  >
                    <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={16} />
                  </button>
                  <Icon name="folder" size={20} />
                  <span className="mono ellipsis grow">
                    {g.pair?.name}/{g.folder}/
                  </span>
                  <span className="muted">{I.folderGroup(g.rows.length, fmtBytes(bytes))}</span>
                  <span className="muted small">{I.detected(fmtDateTime(g.rows[0]!.detectedAt))}</span>
                </div>
                {isOpen
                  ? g.rows.map((r) => (
                      <DelRow
                        key={r.id}
                        r={r}
                        pair={g.pair}
                        checked={sel.has(r.id)}
                        onToggle={() => toggleIds([r.id], !sel.has(r.id))}
                        indent
                      />
                    ))
                  : null}
              </div>
            );
          }
          const r = g.rows[0]!;
          return (
            <DelRow
              key={g.key}
              r={r}
              pair={g.pair}
              checked={sel.has(r.id)}
              onToggle={() => toggleIds([r.id], !sel.has(r.id))}
            />
          );
        })}
      </section>
      <div className="bulk-bar sticky" data-testid="deletion-bar">
        <span>{I.selection(selRows.length, fmtBytes(selBytes))}</span>
        <Button
          variant="ghost"
          small
          onClick={() => setSel(sel.size === list.length ? new Set() : new Set(list.map((d) => d.id)))}
        >
          {sel.size === list.length ? I.selectNone : I.selectAll}
        </Button>
        <span className="spacer" />
        {mixed ? (
          <span className="tone-warn small" data-testid="deletions-mixed">
            {I.mixedSides}
          </span>
        ) : remoteSide ? (
          <>
            <Button
              variant="danger"
              icon="trash"
              busy={busy}
              disabled={!selRows.length}
              onClick={() => void decide('trash_local')}
            >
              {I.trashLocal}
            </Button>
            <Button icon="up" busy={busy} disabled={!selRows.length} onClick={() => void decide('restore_remote')}>
              {I.restoreRemote}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="danger"
              icon="trash"
              busy={busy}
              disabled={!selRows.length}
              onClick={() => void decide('trash_remote')}
            >
              {I.trashRemote}
            </Button>
            <Button icon="down" busy={busy} disabled={!selRows.length} onClick={() => void decide('restore_local')}>
              {I.restoreLocal}
            </Button>
            <Button busy={busy} disabled={!selRows.length} onClick={() => void decide('keep_remote_only')}>
              {I.keepRemoteOnly}
            </Button>
          </>
        )}
      </div>
    </>
  );
}

function DelRow({
  r,
  pair,
  checked,
  onToggle,
  indent,
}: {
  r: PendingDeletionDto;
  pair: PairDto | undefined;
  checked: boolean;
  onToggle: () => void;
  indent?: boolean;
}) {
  return (
    <div className={`del-row${indent ? ' indent' : ''}`} data-testid="deletion-row">
      <Checkbox state={checked} label={r.relPath} onChange={onToggle} />
      <Icon name="file" size={20} />
      <span className="mono ellipsis grow" title={r.relPath}>
        {indent ? r.relPath.slice(r.relPath.lastIndexOf('/') + 1) : `${pair?.name ?? ''}/${r.relPath}`}
      </span>
      {r.remoteChangedSinceDelete ? (
        <Pill tone="warn">
          <Icon name="warn" size={14} /> {I.remoteChanged}
        </Pill>
      ) : null}
      {r.side === 'remote' ? <Pill tone="info">{I.deletedInProton}</Pill> : null}
      <span className="num">{fmtBytes(r.size)}</span>
      <span className="muted small">{I.detected(fmtDateTime(r.detectedAt))}</span>
    </div>
  );
}

// ------------------------------------------------------------------ adoptions

function Adoptions({ list, reload }: { list: AdoptionProposalDto[]; reload: () => void }) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const listKey = list.map((d) => d.id).join(',');
  useEffect(() => setSel(new Set(list.map((a) => a.id))), [listKey]);
  const decide = async (accept: boolean) => {
    setBusy(true);
    try {
      await api.decideAdoptions([...sel], accept);
      toast('ok', I.done);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      reload();
    }
  };
  if (!list.length) return <Empty icon="check">{I.noAdoptions}</Empty>;
  const bytes = list.filter((a) => sel.has(a.id)).reduce((s, a) => s + a.size, 0);
  return (
    <>
      <div className="muted">{I.adoptionsIntro}</div>
      <section className="card adopt-list">
        <div className="thead adopt-grid">
          <span />
          <span>{I.adoptSource}</span>
          <span />
          <span>{I.adoptTarget}</span>
          <span className="num">{t.activity.col.size}</span>
        </div>
        {list.map((a) => (
          <div key={a.id} className="adopt-row adopt-grid">
            <Checkbox
              state={sel.has(a.id)}
              label={a.targetRelPath}
              onChange={() =>
                setSel((s) => {
                  const n = new Set(s);
                  if (n.has(a.id)) n.delete(a.id);
                  else n.add(a.id);
                  return n;
                })
              }
            />
            <span className="mono ellipsis" title={a.sourceRemotePath}>
              {a.sourceRemotePath}
            </span>
            <span title={a.outsidePair ? I.outsidePair : undefined} className={a.outsidePair ? 'tone-warn' : ''}>
              <Icon name={a.outsidePair ? 'warn' : 'chevronRight'} size={16} />
            </span>
            <span className="mono ellipsis" title={a.targetRelPath}>
              {a.targetRelPath}
            </span>
            <span className="num" title={I.adoptMatch[a.matchedBy]}>
              {fmtBytes(a.size)}
            </span>
          </div>
        ))}
      </section>
      <div className="bulk-bar sticky">
        <span>{I.selection(sel.size, fmtBytes(bytes))}</span>
        <span className="spacer" />
        <Button variant="primary" busy={busy} disabled={!sel.size} onClick={() => void decide(true)}>
          {I.accept}
        </Button>
        <Button busy={busy} disabled={!sel.size} onClick={() => void decide(false)}>
          {I.reject}
        </Button>
      </div>
    </>
  );
}
