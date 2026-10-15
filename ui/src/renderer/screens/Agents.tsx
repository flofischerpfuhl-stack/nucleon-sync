// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Settings → Agents & API (ARCHITECTURE §7): agent tokens (create with scopes, show the secret once, disable,
 * revoke, rotate the built-in one) and the agents' requests waiting for approval.
 */
import { useRef, useState } from 'react';

import type { AgentPermission, CreateAgentTokenResponse } from '@nucleon-sync/shared';

import { api } from '../api.ts';
import { useFocusTrap } from '../components/a11y.ts';
import { Button, Checkbox, Empty, Pill } from '../components/ui.tsx';
import { fmtAgo, fmtClock } from '../format.ts';
import { section, t } from '../i18n/index.ts';
import { confirmText } from '../logic/confirmText.ts';
import { AGENT_PERMISSIONS } from '../shared.ts';
import { toast, toastError, useApi, useStore, withConfirm } from '../store.ts';

const G = section('agents');

export function AgentsCard() {
  const online = useStore((s) => s.connection === 'connected');
  const tokens = useApi(() => api.tokens(), [], ['approval']);
  const approvals = useApi(() => api.approvals(), [], ['approval']);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateAgentTokenResponse | null>(null);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      const r = await fn();
      if (r !== null && ok) toast('ok', ok);
      tokens.reload();
    } catch (e) {
      toastError(e);
    }
  };
  const open = (approvals.data ?? []).filter((a) => a.state === 'pending');
  return (
    <section className="card" data-testid="agents-card">
      <h2>{t.settings.agents}</h2>
      <p className="muted">{t.settings.agentsInfo}</p>

      <h3>{G.approvals}</h3>
      {open.length ? (
        open.map((a) => (
          <div key={a.id} className="token-row" data-testid="approval-row">
            <b>{a.tokenName}</b>
            <span>{confirmText(a.summary).title}</span>
            <span className="muted small">{t.confirm.expires(fmtClock(a.expiresAt))}</span>
            <span className="row">
              <Button small onClick={() => void act(() => api.decideApproval(a.id, false), G.denied)}>
                {G.deny}
              </Button>
              <Button small variant="danger" onClick={() => void act(() => api.decideApproval(a.id, true), G.approved)}>
                {G.approve}
              </Button>
            </span>
          </div>
        ))
      ) : (
        <div className="muted small">{G.noApprovals}</div>
      )}

      <div className="card-head" style={{ marginTop: 16 }}>
        <h3>{G.tokens}</h3>
        <Button small icon="plus" disabled={!online} onClick={() => setCreating(true)} data-testid="create-token">
          {G.create.replace(' …', '')}
        </Button>
      </div>
      {tokens.error ? (
        <Empty icon="info">{tokens.error.notImplemented ? t.maintenance.unavailable : tokens.error.message}</Empty>
      ) : (
        <div data-testid="token-list">
          {(tokens.data ?? []).map((tk) => (
            <div key={tk.id} className="token-row" data-testid={`token-${tk.name}`}>
              <span>
                <b>{tk.name}</b> {tk.builtin ? <Pill tone="muted">{G.builtin}</Pill> : null}{' '}
                {tk.disabled ? <Pill tone="warn">{G.disabled}</Pill> : null}
                <div className="mono small muted ellipsis" title={tk.file ?? ''}>
                  {tk.prefix}
                  {tk.file ? ` · ${tk.file}` : ''}
                </div>
              </span>
              <span className="small">{tk.scopes.map((s) => G.scopeShort[s]).join(' · ')}</span>
              <span className="muted small">
                {G.lastUsed}: {tk.lastUsedAt ? fmtAgo(tk.lastUsedAt) : G.never}
              </span>
              <span className="row">
                <Button
                  small
                  disabled={!online}
                  onClick={() => void act(() => api.patchToken(tk.id, { disabled: !tk.disabled }))}
                >
                  {tk.disabled ? G.enable : G.disable}
                </Button>
                {tk.builtin ? (
                  <Button
                    small
                    disabled={!online}
                    onClick={() => void act(() => withConfirm((tok) => api.rotateDefaultToken(tok)), G.rotated)}
                  >
                    {G.rotate}
                  </Button>
                ) : (
                  <Button
                    small
                    variant="danger"
                    disabled={!online}
                    onClick={() => void act(() => withConfirm((tok) => api.revokeToken(tk.id, tok)), G.revoked)}
                  >
                    {G.revoke}
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="muted small">{G.skillHint}</p>
      {creating ? (
        <CreateTokenDialog
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreated(c);
            tokens.reload();
          }}
        />
      ) : null}
      {created ? <SecretDialog token={created} onClose={() => setCreated(null)} /> : null}
    </section>
  );
}

function CreateTokenDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (t: CreateAgentTokenResponse) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<AgentPermission>>(new Set(['read', 'sync']));
  const [writeFile, setWriteFile] = useState(true);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  useFocusTrap(box, true, first);
  const toggle = (p: AgentPermission) =>
    setScopes((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      n.add('read');
      return n;
    });
  const create = async () => {
    setBusy(true);
    try {
      onCreated(await api.createToken(name.trim(), [...scopes], writeFile));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        ref={box}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="token-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        data-testid="create-token-dialog"
      >
        <h2 id="token-title">{G.createTitle}</h2>
        <label className="field">
          <span>{G.name}</span>
          <input
            ref={first}
            value={name}
            maxLength={40}
            placeholder={G.namePlaceholder}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()}
            data-testid="token-name"
          />
        </label>
        <div className="scope-list" role="group" aria-label={G.scopes}>
          {AGENT_PERMISSIONS.map((p) => (
            <label key={p}>
              <Checkbox state={scopes.has(p)} onChange={() => toggle(p)} disabled={p === 'read'} label={G.scope[p]} />
              <span>
                <b>{G.scopeShort[p]}</b> – {G.scope[p]}
              </span>
            </label>
          ))}
          <label>
            <Checkbox state={writeFile} onChange={() => setWriteFile(!writeFile)} label={G.writeFile} />
            <span>{G.writeFile}</span>
          </label>
        </div>
        <div className="modal-actions">
          <Button onClick={onClose}>{t.actions.cancel}</Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void create()}>
            {G.create.replace(' …', '')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SecretDialog({ token, onClose }: { token: CreateAgentTokenResponse; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(box, true, copyRef);
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        ref={box}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="secret-title"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        data-testid="token-secret-dialog"
      >
        <h2 id="secret-title">
          {G.secret}: {token.name}
        </h2>
        <p>{G.created}</p>
        <div className="secret-box mono" data-testid="token-secret">
          {token.token}
        </div>
        {token.file ? (
          <p className="muted small">
            {G.file}: <span className="mono">{token.file}</span>
            <br />
            {G.useWith(token.name)}
          </p>
        ) : null}
        <div className="modal-actions">
          <button
            ref={copyRef}
            type="button"
            className="btn btn-secondary"
            onClick={() => void window.nucleonSync.copyText(token.token).then(() => setCopied(true))}
          >
            {copied ? t.actions.copied : t.actions.copy}
          </button>
          <Button variant="primary" onClick={onClose}>
            {t.actions.close}
          </Button>
        </div>
      </div>
    </div>
  );
}
