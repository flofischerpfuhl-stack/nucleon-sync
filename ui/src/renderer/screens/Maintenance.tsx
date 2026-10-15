// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Maintenance screen: digest backfill, Proton trash, doctor, job queue,
 * read-only Proton CLI console.
 */
import { useEffect, useState } from 'react';

import type { CliPassthroughResponse, DoctorCheck, JobDto } from '@nucleon-sync/shared';

import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { Button, Chips, Progress } from '../components/ui.tsx';
import { fmtBytes, fmtCount, fmtDateTime, fmtPercent } from '../format.ts';
import { section, t } from '../i18n/index.ts';
import { daemonText } from '../logic/daemonText.ts';
import { asArray, normalizeMaintenance } from '../logic/normalize.ts';
import { toast, toastError, useApi, useStore, withConfirm } from '../store.ts';

const M = section('maintenance');

export function Maintenance() {
  const status = useStore((s) => s.status);
  const online = useStore((s) => s.connection === 'connected');
  const summary = useApi(async () => normalizeMaintenance(await api.maintenanceSummary()), [], ['run', 'job']);
  const accounts = status?.accounts ?? [];
  const pairs = (status?.pairs ?? []).filter((p) => p.direction !== 'mirror-down');
  const [pairId, setPairId] = useState<number | null>(null);
  const [prefix, setPrefix] = useState('');
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const accName = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? id;
  const bf = summary.data?.backfill ?? null;

  // poll backfill progress while it runs
  useEffect(() => {
    if (!bf || bf.done >= bf.total) return;
    const t = setInterval(summary.reload, 1500);
    return () => clearInterval(t);
  }, [bf, summary.reload]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const unavailable = summary.error?.notImplemented;

  return (
    <div className="stack">
      <section className="card">
        <h2>{M.digest}</h2>
        <p className="muted">{M.digestIntro}</p>
        {unavailable ? <div className="muted">{M.unavailable}</div> : null}
        {summary.data?.digestMissing
          .filter((x) => x.files > 0)
          .map((x) => (
            <div key={x.accountId} className="maint-line">
              <b>{accName(x.accountId)}:</b> {M.digestCounts(x.files, fmtBytes(x.bytes))}
              {x.duplicateFiles ? (
                <div className="muted">{M.digestPriority(x.duplicateFiles, fmtBytes(x.duplicateBytes))}</div>
              ) : null}
            </div>
          ))}
        <div className="row">
          <label className="field-inline">
            <span>{M.folder}</span>
            <select value={pairId ?? pairs[0]?.id ?? ''} onChange={(e) => setPairId(Number(e.target.value))}>
              {pairs.map((p) => (
                <option key={p.id} value={p.id}>
                  {accName(p.accountId)} · {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-inline">
            <span>{M.subfolder}</span>
            <input
              className="mono"
              value={prefix}
              placeholder={M.subfolderPlaceholder}
              onChange={(e) => setPrefix(e.target.value)}
            />
          </label>
          <Button
            variant="primary"
            icon="play"
            disabled={!online || !pairs.length || (!!bf && bf.done < bf.total)}
            busy={busy === 'digest'}
            onClick={() =>
              void act('digest', async () => {
                await api.digestBackfill(pairId ?? pairs[0]!.id, prefix.trim().replace(/^\/+|\/+$/g, '') || undefined);
                toast('ok', M.started);
                summary.reload();
              })
            }
          >
            {M.start}
          </Button>
          {bf ? (
            <div className="grow maint-progress">
              <span>
                {M.progress} {fmtPercent(bf.done / Math.max(1, bf.total))} · {fmtCount(bf.done)}/{fmtCount(bf.total)}
              </span>
              <Progress value={bf.done / Math.max(1, bf.total)} />
            </div>
          ) : null}
        </div>
        <div className="muted small">
          <Icon name="info" size={14} /> {M.trashHint}
        </div>
      </section>

      <section className="card">
        <h2>{M.trash}</h2>
        {unavailable ? <div className="muted">{M.unavailable}</div> : null}
        {summary.data?.trash.map((tr) => (
          <div key={tr.accountId} className="maint-line row">
            <b>{accName(tr.accountId)}:</b>
            <span>{M.trashLine(fmtBytes(tr.bytes), tr.items, tr.ownItems)}</span>
            <span className="spacer" />
            <Button
              variant="danger"
              icon="trash"
              disabled={!online || tr.items === 0}
              busy={busy === `trash-${tr.accountId}`}
              onClick={() =>
                void act(`trash-${tr.accountId}`, async () => {
                  const r = await withConfirm((tok) => api.emptyTrash(tr.accountId, tok));
                  if (r) {
                    toast('ok', M.trashEmptied);
                    summary.reload();
                  }
                })
              }
            >
              {M.emptyTrash}
            </Button>
          </div>
        ))}
        <div className="muted small">{M.emptyTrashHint}</div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>{M.doctor}</h2>
          <Button
            icon="refresh"
            busy={busy === 'doctor'}
            onClick={() => void act('doctor', async () => setChecks(asArray(await api.doctor())))}
          >
            {M.runDoctor}
          </Button>
        </div>
        {checks ? (
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.id} className={c.ok ? 'tone-ok' : c.severity === 'error' ? 'tone-err' : 'tone-warn'}>
                <Icon name={c.ok ? 'check' : c.severity === 'error' ? 'error' : 'warn'} size={18} />
                <span className="mono">{c.id}</span>
                <span className="check-msg">{daemonText(c.message, c.msg)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <JobQueue />
      <CliConsole accounts={accounts.map((a) => ({ id: a.id, name: a.displayName }))} online={online} />
    </div>
  );
}

const JOB_STATES: JobDto['state'][] = ['running', 'queued', 'retry_wait', 'failed', 'blocked'];

/** GET /v1/jobs by state (the CLI's `nucleon-sync jobs --state S`) */
function JobQueue() {
  const [state, setState] = useState<JobDto['state']>('running');
  const jobs = useApi(() => api.jobs(state, 200), [state], ['job', 'run']);
  return (
    <section className="card" data-testid="job-queue">
      <div className="card-head">
        <h2>{M.queue}</h2>
        <Chips<JobDto['state']>
          label={M.queue}
          options={JOB_STATES.map((s) => ({ value: s, label: M.jobState[s] ?? s }))}
          value={state}
          onChange={setState}
        />
      </div>
      <div className="muted small">{M.queueIntro}</div>
      {(jobs.data ?? []).length === 0 ? (
        <div className="muted" style={{ padding: '8px 0' }}>
          {M.noJobs}
        </div>
      ) : (
        (jobs.data ?? []).slice(0, 200).map((j) => (
          <div key={j.id} className="job-row">
            <span className="mono">#{j.id}</span>
            <span>
              {j.type} · {j.accountId}
            </span>
            <span className="muted">
              {j.bytes ? fmtBytes(j.bytes) : ''}
              {j.attempts ? ` · ${M.attempts(j.attempts)}` : ''}
            </span>
            <span className="ellipsis" title={`${j.relPath ?? ''} ${daemonText(j.lastError, j.lastErrorMsg)}`}>
              {j.relPath ?? ''}
              {j.lastError ? <span className="tone-err"> · {daemonText(j.lastError, j.lastErrorMsg)}</span> : null}
              {j.notBefore ? <span className="muted"> · {fmtDateTime(j.notBefore)}</span> : null}
            </span>
          </div>
        ))
      )}
    </section>
  );
}

/** read-only passthrough to the official CLI (POST /v1/accounts/:id/cli, `nucleon-sync cli`) */
function CliConsole({ accounts, online }: { accounts: { id: string; name: string }[]; online: boolean }) {
  const [account, setAccount] = useState(accounts[0]?.id ?? '');
  const [args, setArgs] = useState('filesystem list -j /my-files');
  const [out, setOut] = useState<CliPassthroughResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const argv = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map((a) => a.replace(/^["']|["']$/g, '')) ?? [];
      setOut(await api.cli(account || accounts[0]?.id || '', argv));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" data-testid="cli-console">
      <h2>{M.cli}</h2>
      <div className="muted small">{M.cliIntro}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <select aria-label={t.activity.col.account} value={account} onChange={(e) => setAccount(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="mono muted">proton-drive</span>
        <input
          className="mono grow"
          aria-label={M.cliArgs}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && void run()}
        />
        <Button icon="play" busy={busy} disabled={!online || !accounts.length} onClick={() => void run()}>
          {M.cliRun}
        </Button>
      </div>
      {out ? (
        <>
          <div className={`small ${out.exitCode === 0 ? 'tone-ok' : 'tone-err'}`}>{M.cliExit(out.exitCode)}</div>
          <pre className="cli-output">{out.stdout || out.stderr}</pre>
        </>
      ) : null}
    </section>
  );
}
