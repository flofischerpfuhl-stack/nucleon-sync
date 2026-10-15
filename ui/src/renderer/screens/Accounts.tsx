// SPDX-License-Identifier: GPL-3.0-or-later
/** docs/SYNC-RULES.md Konten: account cards, add account, login dialog (URL + QR from SSE `login`), logout with confirm. */
import { useState } from 'react';

import type { AccountDto } from '@nucleon-sync/shared';

import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { QrCode } from '../components/QrCode.tsx';
import { Avatar, Button, Dot, PauseControl, Pill, Spinner, Switch, accountTone } from '../components/ui.tsx';
import { fmtAgo } from '../format.ts';
import { section, t } from '../i18n/index.ts';
import { daemonText } from '../logic/daemonText.ts';
import { slugify } from '../logic/paths.ts';
import { getState, setState, toast, toastError, useStore, withConfirm } from '../store.ts';

const A = section('accounts');

export function Accounts() {
  const status = useStore((s) => s.status);
  const online = useStore((s) => s.connection === 'connected');
  const [adding, setAdding] = useState(false);
  const [loginFor, setLoginFor] = useState<string | null>(null);
  const accounts = status?.accounts ?? [];
  const startLogin = async (id: string) => {
    setState((s) => ({ login: { ...s.login, [id]: { phase: 'starting' } } }));
    setLoginFor(id);
    try {
      const r = await api.login(id);
      setState((s) => ({
        login: {
          ...s.login,
          [id]: {
            ...s.login[id],
            phase: s.login[id]?.phase === 'starting' ? 'url' : s.login[id]!.phase,
            signInUrl: r.signInUrl,
          },
        },
      }));
    } catch (e) {
      setState((s) => ({ login: { ...s.login, [id]: { phase: 'failed', message: (e as Error).message } } }));
    }
  };
  return (
    <div className="stack">
      <div className="row">
        <span className="muted">{A.multiHint}</span>
        <span className="spacer" />
        <Button variant="primary" icon="plus" disabled={!online} onClick={() => setAdding(true)}>
          {A.add.replace('+ ', '')}
        </Button>
      </div>
      {adding ? (
        <AddAccount
          onCancel={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            void startLogin(id);
          }}
        />
      ) : null}
      {loginFor ? (
        <LoginPanel
          accountId={loginFor}
          name={accounts.find((a) => a.id === loginFor)?.displayName ?? loginFor}
          onClose={() => {
            // closing while the service still waits for the confirmation cancels the login
            const ph = getState().login[loginFor]?.phase;
            if (ph === 'starting' || ph === 'url') void api.cancelLogin(loginFor).catch(() => undefined);
            setLoginFor(null);
          }}
          onRetry={() => void startLogin(loginFor)}
        />
      ) : null}
      {accounts.map((a) => (
        <AccountRow
          key={a.id}
          a={a}
          pairs={status?.pairs.filter((p) => p.accountId === a.id).length ?? 0}
          online={online}
          onLogin={() => void startLogin(a.id)}
        />
      ))}
    </div>
  );
}

function AccountRow({
  a,
  pairs,
  online,
  onLogin,
}: {
  a: AccountDto;
  pairs: number;
  online: boolean;
  onLogin: () => void;
}) {
  const tone = accountTone(a.status);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.displayName);
  const [workers, setWorkers] = useState(a.workers.configured);
  const [enabled, setEnabled] = useState(a.status !== 'disabled');
  const logout = async () => {
    try {
      const r = await withConfirm((tok) => api.logout(a.id, tok));
      if (r) toast('ok', A.loggedOut);
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async () => {
    try {
      const r = await withConfirm((tok) => api.removeAccount(a.id, tok));
      if (r) toast('ok', A.removed);
    } catch (e) {
      toastError(e);
    }
  };
  const save = async () => {
    try {
      await api.patchAccount(a.id, {
        displayName: name.trim() || a.displayName,
        workers,
        ...(enabled !== (a.status !== 'disabled') ? { enabled } : {}),
      });
      toast('ok', A.saved);
      setEditing(false);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <section className="card account-row" data-testid={`account-row-${a.id}`}>
      <Avatar name={a.displayName} accountId={a.id} />
      <div className="grow">
        <div className="acc-line">
          <b className="acc-name">{a.displayName}</b>
          <span className="muted">{a.email ?? '–'}</span>
          <Pill tone={a.paused ? 'muted' : tone}>
            <Dot tone={a.paused ? 'muted' : tone} />
            {a.paused ? t.account.paused : a.status === 'ok' ? A.loggedIn : t.account.status[a.status]}
          </Pill>
        </div>
        <div className="muted small">
          <Icon name="key" size={14} /> {t.account.backend[a.credentialBackend]} ·{' '}
          {t.account.workers(a.workers.active, a.workers.configured)} · {t.account.pairs(pairs)} · {A.lastOk}{' '}
          {fmtAgo(a.lastOkAt)}
        </div>
        {a.lastError && a.status !== 'ok' ? (
          <div className="acc-error">
            {A.lastError}: {daemonText(a.lastError, a.lastErrorMsg)}
          </div>
        ) : null}
        {editing ? (
          <div className="pair-extra" data-testid={`account-edit-${a.id}`}>
            <label className="field-inline">
              <span>{A.nameLabel}</span>
              <input value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field-inline">
              <span>{A.workers}</span>
              <input
                type="number"
                min={1}
                max={4}
                value={workers}
                style={{ width: 70 }}
                onChange={(e) => setWorkers(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
              />
            </label>
            <label className="field-inline">
              <span>{A.enabled}</span>
              <Switch checked={enabled} label={A.enabled} onChange={setEnabled} />
            </label>
            <span className="spacer" />
            <Button small onClick={() => setEditing(false)}>
              {t.actions.cancel}
            </Button>
            <Button small variant="primary" onClick={() => void save()}>
              {t.actions.save}
            </Button>
            <Button small variant="danger" icon="trash" disabled={!online} onClick={() => void remove()}>
              {A.remove}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="row-actions">
        <Button
          small
          icon="key"
          variant={a.status === 'needs_login' ? 'primary' : 'secondary'}
          disabled={!online}
          onClick={onLogin}
        >
          {A.relogin}
        </Button>
        <Button small disabled={!online || a.status === 'needs_login'} onClick={() => void logout()}>
          {A.logout}
        </Button>
        <PauseControl small paused={a.paused} disabled={!online} target={{ scope: 'account', id: a.id }} />
        <Button
          small
          icon="settings"
          disabled={!online}
          aria-expanded={editing}
          onClick={() => {
            setName(a.displayName);
            setWorkers(a.workers.configured);
            setEnabled(a.status !== 'disabled');
            setEditing(!editing);
          }}
        >
          {t.actions.edit}
        </Button>
      </div>
    </section>
  );
}

function AddAccount({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const effectiveId = id || slugify(name);
  const create = async () => {
    setBusy(true);
    try {
      await api.createAccount(effectiveId, name.trim());
      onCreated(effectiveId);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card add-account">
      <h2>{A.add.replace('+ ', '')}</h2>
      <div className="form-row">
        <label className="field">
          <span>{A.nameLabel}</span>
          <input value={name} autoFocus placeholder={A.namePlaceholder} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>{A.idLabel}</span>
          <input value={effectiveId} onChange={(e) => setId(slugify(e.target.value))} className="mono" />
          <small className="muted">{A.idHelp}</small>
        </label>
      </div>
      <div className="row-end">
        <Button onClick={onCancel}>{t.actions.cancel}</Button>
        <Button
          variant="primary"
          icon="key"
          busy={busy}
          disabled={!name.trim() || effectiveId.length < 2}
          onClick={() => void create()}
        >
          {A.startLogin}
        </Button>
      </div>
    </section>
  );
}

export function LoginPanel({
  accountId,
  name,
  onClose,
  onRetry,
}: {
  accountId: string;
  name: string;
  onClose?: () => void;
  onRetry: () => void;
}) {
  const login = useStore((s) => s.login[accountId]);
  const [copied, setCopied] = useState(false);
  const url = login?.signInUrl;
  return (
    <section className="card login" data-testid="login-dialog">
      <div className="card-head">
        <h2>{A.loginTitle(name)}</h2>
        {onClose ? (
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t.actions.close}>
            <Icon name="close" size={18} />
          </button>
        ) : null}
      </div>
      {login?.phase === 'done' ? (
        <div className="login-done tone-ok">
          <Icon name="check" size={28} /> {A.loginDone}
        </div>
      ) : login?.phase === 'failed' ? (
        <div className="login-failed">
          <div className="tone-err">
            {A.loginFailed}
            {login.message ? `: ${daemonText(login.message, login.msg)}` : ''}
          </div>
          <Button onClick={onRetry}>{t.actions.retry}</Button>
        </div>
      ) : (
        <div className="login-body">
          <div className="qr-wrap">{url ? <QrCode text={url} label={url} /> : <Spinner />}</div>
          <div className="login-text">
            <p>{A.loginIntro(name)}</p>
            <p className="muted small">{A.thirdParty}</p>
            {url ? (
              <>
                <div className="mono url" data-testid="login-url">
                  {url}
                </div>
                <div className="row">
                  <Button
                    icon="copy"
                    onClick={() =>
                      void window.nucleonSync.copyText(url).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      })
                    }
                  >
                    {copied ? t.actions.copied : A.copyLink}
                  </Button>
                  <Button icon="external" onClick={() => void window.nucleonSync.openExternal(url)}>
                    {A.openBrowser}
                  </Button>
                </div>
              </>
            ) : null}
            <div className="muted waiting">
              <Spinner /> {A.waiting}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
