// SPDX-License-Identifier: GPL-3.0-or-later
/** Pair wizard (docs/SYNC-RULES.md): account → remote folder → local folder (hard-exclusion check) → direction → preview. */
import { useEffect, useRef, useState } from 'react';

import type { CreatePairRequest, PairDirection, PairPreviewDto, RemoteBrowseEntry } from '@nucleon-sync/shared';

import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { Avatar, Button, Empty, Spinner } from '../components/ui.tsx';
import { toApiError } from '../errors.ts';
import { fmtBytes, fmtCount } from '../format.ts';
import { section, t } from '../i18n/index.ts';
import { daemonText } from '../logic/daemonText.ts';
import { nestingHint, validateLocalRoot } from '../logic/paths.ts';
import { DIRECTION_ICON } from '../logic/status.ts';
import { toast, toastError, useStore } from '../store.ts';

const W = section('wizard');

/** debounce of the local folder check while typing; "Weiter" stays disabled until the check ran */
export const LOCAL_CHECK_DELAY_MS = 300;

export function PairWizard({ onDone }: { onDone: () => void }) {
  const accounts = useStore((s) => s.status?.accounts ?? []);
  const pairs = useStore((s) => s.status?.pairs ?? []);
  const [step, setStep] = useState(0);
  const [accountId, setAccountId] = useState<string | null>(accounts[0]?.id ?? null);
  const [remote, setRemote] = useState('/');
  const [localRoot, setLocalRoot] = useState('');
  const [direction, setDirection] = useState<PairDirection>('backup');
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<PairPreviewDto | null | 'unavailable'>(null);
  const [busy, setBusy] = useState(false);

  // local folder check: pending until the (debounced) validation of exactly this input finished
  const [checked, setChecked] = useState<{ root: string; error: string | null } | null>(null);
  const pairsRef = useRef(pairs);
  pairsRef.current = pairs;
  const pairsKey = pairs.map((p) => `${p.localRoot}\t${p.remoteRoot}`).join('\n');
  // nested pairs: the Proton folder (chosen before) must be nested at the same sub path
  const target = accountId && remote !== '/' ? { accountId, remoteRoot: remote } : undefined;
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    const root = localRoot;
    if (!root.trim()) return;
    const t = setTimeout(
      () => setChecked({ root, error: validateLocalRoot(root, pairsRef.current, targetRef.current) }),
      LOCAL_CHECK_DELAY_MS,
    );
    return () => clearTimeout(t);
  }, [localRoot, pairsKey, accountId, remote]);
  const validating = !!localRoot.trim() && checked?.root !== localRoot;
  const localError = !validating && localRoot.trim() ? (checked?.error ?? null) : null;
  const localOk = !!localRoot.trim() && !validating && !localError;
  const nested = localOk ? nestingHint(localRoot, pairs) : null;
  const pick = (p: string) => {
    setLocalRoot(p);
    setChecked({ root: p, error: validateLocalRoot(p, pairsRef.current, targetRef.current) }); // picked: check now
  };
  const req: CreatePairRequest | null =
    accountId && remote !== '/' && localOk
      ? {
          accountId,
          name: name || remote.split('/').pop() || 'Paar',
          localRoot,
          remoteRoot: remote,
          direction,
          enabled: true,
        }
      : null;
  const canNext = [!!accountId, remote !== '/', localOk, !!name.trim() || !!req, true][step];

  useEffect(() => {
    if (step !== 4 || !req) return;
    setPreview(null);
    api
      .previewPair(req)
      .then(setPreview)
      .catch((e) => {
        if (toApiError(e).notImplemented) setPreview('unavailable');
        else toastError(e);
      });
  }, [step]);

  const create = async () => {
    if (!req) return;
    setBusy(true);
    try {
      await api.createPair(req);
      toast('ok', W.created);
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wizard">
      <div className="wizard-head">
        <h2>{W.title}</h2>
        <ol className="steps">
          {W.steps.map((s, i) => (
            <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>
              <span className="step-n">{i < step ? <Icon name="check" size={14} /> : i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      </div>
      <section className="card wizard-body">
        {step === 0 ? (
          <>
            <h3>{W.chooseAccount}</h3>
            <div className="choice-grid">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`choice${a.id === accountId ? ' on' : ''}`}
                  onClick={() => setAccountId(a.id)}
                >
                  <Avatar name={a.displayName} accountId={a.id} />
                  <span>
                    <b>{a.displayName}</b>
                    <span className="muted small">{a.email ?? ''}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : null}
        {step === 1 && accountId ? (
          <>
            <h3>{W.chooseRemote}</h3>
            <RemoteBrowser accountId={accountId} path={remote} onPath={setRemote} />
            <div className="muted">{remote !== '/' ? W.remoteSelected(remote) : null}</div>
          </>
        ) : null}
        {step === 2 ? (
          <>
            <h3>{W.chooseLocal}</h3>
            <div className="row">
              <input
                className="grow mono"
                value={localRoot}
                placeholder={W.localPlaceholder}
                onChange={(e) => setLocalRoot(e.target.value)}
                aria-label={W.chooseLocal}
              />
              <Button
                icon="folder"
                onClick={() =>
                  void window.nucleonSync.pickFolder(localRoot || undefined).then((p) => {
                    if (p) pick(p);
                  })
                }
              >
                {W.pickFolder}
              </Button>
            </div>
            {validating ? (
              <div className="muted loading-line" data-testid="local-checking">
                <Spinner /> {W.checking}
              </div>
            ) : null}
            {localError ? (
              <div className="tone-err" data-testid="local-error">
                {localError}
              </div>
            ) : null}
            {nested ? (
              <div className="tone-info" data-testid="local-nested">
                {nested}
              </div>
            ) : null}
          </>
        ) : null}
        {step === 3 ? (
          <>
            <h3>{W.chooseDirection}</h3>
            <div className="choice-list">
              {(Object.keys(W.directionHelp) as PairDirection[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`choice${d === direction ? ' on' : ''}`}
                  onClick={() => setDirection(d)}
                >
                  <Icon name={DIRECTION_ICON[d]} size={22} />
                  <span>
                    <b>{t.pair.direction[d]}</b>
                    <span className="muted small">{W.directionHelp[d]}</span>
                  </span>
                </button>
              ))}
            </div>
            <label className="field">
              <span>{W.name}</span>
              <input value={name} placeholder={remote.split('/').pop()} onChange={(e) => setName(e.target.value)} />
            </label>
          </>
        ) : null}
        {step === 4 ? (
          <>
            <h3>{W.preview}</h3>
            <div className="mono muted">
              {localRoot} ⇄ {remote} · {t.pair.direction[direction]}
            </div>
            {preview === null ? (
              <div className="loading-line">
                <Spinner />
              </div>
            ) : preview === 'unavailable' ? (
              <Empty icon="info">{W.previewUnavailable}</Empty>
            ) : (
              <>
                <div className="preview-grid">
                  <Stat label={W.previewRows.adopt} value={fmtCount(preview.adopt)} tone="ok" />
                  <Stat
                    label={W.previewRows.upload}
                    value={`${fmtCount(preview.upload)} · ${fmtBytes(preview.uploadBytes)}`}
                    tone="info"
                  />
                  <Stat
                    label={W.previewRows.download}
                    value={`${fmtCount(preview.download)} · ${fmtBytes(preview.downloadBytes)}`}
                    tone="info"
                  />
                  <Stat
                    label={W.previewRows.conflicts}
                    value={fmtCount(preview.conflicts)}
                    tone={preview.conflicts ? 'warn' : 'ok'}
                  />
                  <Stat label={W.previewRows.excluded} value={fmtCount(preview.excluded)} tone="muted" />
                </div>
                {preview.warnings?.length ? (
                  <div data-testid="preview-warnings">
                    {preview.warnings.map((w, k) => (
                      <div key={k} className="tone-warn small">
                        <Icon name="warn" size={14} /> {daemonText(w, preview.warningMsgs?.[k])}
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </section>
      <div className="wizard-foot">
        <Button onClick={() => (step === 0 ? onDone() : setStep(step - 1))}>
          {step === 0 ? t.actions.cancel : t.actions.back}
        </Button>
        <span className="spacer" />
        {step < 4 ? (
          <Button
            variant="primary"
            disabled={!canNext}
            onClick={() => canNext && setStep(step + 1)}
            data-testid="wizard-next"
          >
            {t.actions.next}
          </Button>
        ) : (
          <Button variant="primary" busy={busy} disabled={!req} onClick={() => void create()}>
            {W.create}
          </Button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="stat">
      <div className={`stat-value tone-${tone}`}>{value}</div>
      <div className="muted">{label}</div>
    </div>
  );
}

function RemoteBrowser({ accountId, path, onPath }: { accountId: string; path: string; onPath: (p: string) => void }) {
  const [entries, setEntries] = useState<RemoteBrowseEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setEntries(null);
    api
      .browse(accountId, path)
      .then((e) => {
        setEntries(e.filter((x) => x.type === 'folder'));
        setError(null);
      })
      .catch((e) => setError(toApiError(e).notImplemented ? t.errors.notImplemented : toApiError(e).message));
  }, [accountId, path]);
  const parts = path.split('/').filter(Boolean);
  return (
    <div className="browser">
      <div className="crumbs">
        <button type="button" onClick={() => onPath('/')}>
          {t.wizard.driveRoot}
        </button>
        {parts.map((p, i) => (
          <span key={i}>
            <Icon name="chevronRight" size={14} />
            <button type="button" onClick={() => onPath('/' + parts.slice(0, i + 1).join('/'))}>
              {p}
            </button>
          </span>
        ))}
      </div>
      <div className="browser-list">
        {error ? <Empty icon="info">{error}</Empty> : null}
        {!error && entries === null ? (
          <div className="loading-line">
            <Spinner />
          </div>
        ) : null}
        {entries?.length === 0 ? <div className="muted pad">{t.wizard.browseEmpty}</div> : null}
        {entries?.map((e) => (
          <button
            key={e.uid}
            type="button"
            className="browser-item"
            onClick={() => onPath(`${path === '/' ? '' : path}/${e.name}`)}
          >
            <Icon name="folder" size={20} />
            {e.name}
            <Icon name="chevronRight" size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}
