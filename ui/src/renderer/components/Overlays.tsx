// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Modal dialogs (confirmation of destructive actions, choices, agent approvals, keyboard help) and toasts.
 * Every dialog traps the focus (Tab cycles inside), closes with Esc and returns the focus where it was.
 */
import { useEffect, useRef, useState } from 'react';

import type { ApprovalDto } from '@nucleon-sync/shared';

import { api } from '../api.ts';

import { fmtBytes, fmtClock } from '../format.ts';
import { t } from '../i18n/index.ts';
import { confirmText } from '../logic/confirmText.ts';
import { setState, toast, toastError, useStore } from '../store.ts';
import { SHORTCUTS, useFocusTrap } from './a11y.ts';
import { Icon } from './Icon.tsx';

export function ConfirmHost() {
  const c = useStore((s) => s.confirm);
  // the safe choice ("Cancel") has the initial focus: Enter right after the dialog opened never deletes anything
  const cancelRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useFocusTrap(boxRef, !!c, cancelRef);
  useEffect(() => {
    if (!c) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && c.resolve(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [c]);
  if (!c) return null;
  const s = c.summary;
  const txt = confirmText(s);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => c.resolve(false)}>
      <div
        ref={boxRef}
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <Icon name="warn" size={22} />
          </span>
          <div>
            <div className="eyebrow">{t.confirm.title}</div>
            <h2 id="confirm-title">{txt.title}</h2>
          </div>
        </div>
        <div className="modal-meta">
          {t.confirm.items(s.items)}
          {s.bytes ? ` · ${fmtBytes(s.bytes)}` : ''}
          {c.expiresAt ? ` · ${t.confirm.expires(fmtClock(c.expiresAt))}` : ''}
        </div>
        {txt.details.length ? (
          <ul className="modal-details">
            {txt.details.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : null}
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={() => c.resolve(false)}>
            {t.actions.cancel}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => c.resolve(true)}>
            {t.confirm.proceed}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Non-destructive choice dialog (e.g. unsaved selection changes: apply / discard / back). */
export function ChoiceHost() {
  const c = useStore((s) => s.choice);
  const firstRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useFocusTrap(boxRef, !!c, firstRef);
  useEffect(() => {
    if (!c) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && c.resolve(null);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [c]);
  if (!c) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => c.resolve(null)}>
      <div
        ref={boxRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="choice-title"
        data-testid="choice-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon info">
            <Icon name="info" size={22} />
          </span>
          <div>
            <h2 id="choice-title">{c.title}</h2>
          </div>
        </div>
        <p className="modal-body">{c.body}</p>
        <div className="modal-actions">
          {c.options.map((o, i) => (
            <button
              key={o.id}
              ref={
                o.variant === 'primary' ||
                (i === c.options.length - 1 && !c.options.some((x) => x.variant === 'primary'))
                  ? firstRef
                  : undefined
              }
              type="button"
              className={`btn btn-${o.variant ?? 'secondary'}`}
              data-choice={o.id}
              onClick={() => c.resolve(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** An agent's destructive request waiting for the user (SSE `approval`): approve once or deny. */
export function ApprovalHost() {
  const approvals = useStore((s) => s.approvals);
  const confirmOpen = useStore((s) => !!s.confirm || !!s.choice);
  const a: ApprovalDto | undefined = approvals[0];
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const open = !!a && !confirmOpen;
  useFocusTrap(boxRef, open, denyRef);
  const decide = async (approve: boolean) => {
    if (!a) return;
    setBusy(true);
    try {
      await api.decideApproval(a.id, approve);
      toast(approve ? 'ok' : 'info', approve ? t.agents.approved : t.agents.denied);
    } catch (e) {
      toastError(e);
    } finally {
      setState((s) => ({ approvals: s.approvals.filter((x) => x.id !== a.id) }));
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void decide(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, a?.id]);
  if (!open) return null;
  const txt = confirmText(a.summary);
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        ref={boxRef}
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        data-testid="approval-dialog"
      >
        <div className="modal-head">
          <span className="modal-icon">
            <Icon name="warn" size={22} />
          </span>
          <div>
            <div className="eyebrow">{t.agents.approvalTitle(a.tokenName)}</div>
            <h2 id="approval-title">{txt.title}</h2>
          </div>
        </div>
        <p className="modal-body">{t.agents.approvalIntro}</p>
        <div className="modal-meta">
          {t.confirm.items(a.summary.items)}
          {a.summary.bytes ? ` · ${fmtBytes(a.summary.bytes)}` : ''} · {t.confirm.expires(fmtClock(a.expiresAt))}
          {approvals.length > 1 ? ` · +${approvals.length - 1}` : ''}
        </div>
        {txt.details.length ? (
          <ul className="modal-details">
            {txt.details.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : null}
        <div className="mono small muted">
          {a.method} {a.path}
        </div>
        <div className="modal-actions">
          <button
            ref={denyRef}
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void decide(false)}
          >
            {t.agents.deny}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void decide(true)}
            data-choice="approve"
          >
            {t.agents.approve}
          </button>
        </div>
      </div>
    </div>
  );
}

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="keys">
      {keys.map((k, i) => (
        <span key={k}>
          {i ? ' / ' : ''}
          <kbd>{k}</kbd>
        </span>
      ))}
    </span>
  );
}

/** `?`: all keyboard shortcuts */
export function HelpHost({ screens }: { screens: (keyof typeof t.nav)[] }) {
  const open = useStore((s) => s.helpOpen);
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(boxRef, open, closeRef);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setState({ helpOpen: false });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  const K = t.keys;
  const close = () => setState({ helpOpen: false });
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <div
        ref={boxRef}
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        data-testid="help-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon info">
            <Icon name="info" size={22} />
          </span>
          <div>
            <h2 id="help-title">{K.title}</h2>
          </div>
        </div>
        <p className="modal-body">{K.intro}</p>
        <div className="help-grid">
          <div>
            <h3>{K.groups.navigation}</h3>
            <dl className="help-list">
              {screens.map((id, i) => (
                <div key={id}>
                  <dt>
                    <Keys keys={[String(i + 1)]} />
                  </dt>
                  <dd>{K.goTo(t.nav[id])}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h3>{K.groups.actions}</h3>
            <dl className="help-list">
              {(
                [
                  [SHORTCUTS.sync, K.syncNow],
                  [SHORTCUTS.pause, K.togglePause],
                  [SHORTCUTS.search, K.search],
                  [SHORTCUTS.newPair, K.newPair],
                  [SHORTCUTS.refresh, K.refresh],
                  [SHORTCUTS.help, K.help],
                ] as const
              ).map(([keys, label]) => (
                <div key={label}>
                  <dt>
                    <Keys keys={keys} />
                  </dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
            <h3>{K.groups.lists}</h3>
            <dl className="help-list">
              {(
                [
                  [['Tab', 'Shift+Tab'], K.tab],
                  [['↑', '↓', 'Home', 'End'], K.listMove],
                  [['→', '←', 'Enter'], K.listOpen],
                  [['Space'], K.listToggle],
                  [['Esc'], K.close],
                ] as const
              ).map(([keys, label]) => (
                <div key={label}>
                  <dt>
                    <Keys keys={keys} />
                  </dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        <div className="modal-actions">
          <button ref={closeRef} type="button" className="btn btn-primary" onClick={close}>
            {t.actions.close}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ToastHost() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <Icon name={t.kind === 'err' ? 'error' : t.kind === 'ok' ? 'check' : 'info'} size={18} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
