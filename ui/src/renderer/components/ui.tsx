// SPDX-License-Identifier: GPL-3.0-or-later
/** Small UI building blocks (buttons, pills, chips, checkbox, progress, switches, pause menu). */
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

import type { AccountDto, AccountStatus } from '@nucleon-sync/shared';

import { t } from '../i18n/index.ts';
import { api } from '../api.ts';
import { pauseFor, toastError } from '../store.ts';
import { Icon, type IconName } from './Icon.tsx';

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'muted' | 'accent';

export function accountTone(s: AccountStatus): Tone {
  if (s === 'ok') return 'ok';
  if (s === 'offline' || s === 'error') return 'err';
  if (s === 'disabled') return 'muted';
  return 'warn';
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: IconName;
  small?: boolean;
  busy?: boolean;
};

export function Button({ variant = 'secondary', icon, small, busy, children, className, disabled, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      className={`btn btn-${variant}${small ? ' btn-small' : ''}${busy ? ' busy' : ''} ${className ?? ''}`}
      disabled={disabled || busy}
      {...rest}
    >
      {icon ? <Icon name={icon} size={small ? 16 : 18} /> : null}
      {children}
    </button>
  );
}

export function Pill({ tone = 'muted', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span className={`dot dot-${tone}${pulse ? ' pulse' : ''}`} aria-hidden />;
}

export function Avatar({ name, accountId }: { name: string; accountId: string }) {
  // stable colour from the id (no hard-coded account names)
  let h = 0;
  for (const ch of accountId) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const hue = h;
  return (
    <span className="avatar" style={{ background: `hsl(${hue} 60% 44%)` }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Chips<T extends string | null>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="chips" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`chip${o.value === value ? ' on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function AccountChips({
  accounts,
  value,
  onChange,
}: {
  accounts: AccountDto[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <Chips<string | null>
      label={t.accounts.idLabel}
      options={[{ value: null, label: t.shell.all }, ...accounts.map((a) => ({ value: a.id, label: a.displayName }))]}
      value={value}
      onChange={onChange}
    />
  );
}

export function Checkbox({
  state,
  onChange,
  disabled,
  label,
}: {
  state: 'included' | 'excluded' | 'partial' | boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  const s = state === true ? 'included' : state === false ? 'excluded' : state;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={s === 'included' ? 'true' : s === 'partial' ? 'mixed' : 'false'}
      aria-label={label}
      className={`check check-${s}`}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
    >
      {s === 'included' ? <Icon name="check" size={14} /> : s === 'partial' ? <span className="check-bar" /> : null}
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

export function Progress({
  value,
  tone = 'accent',
  indeterminate,
}: {
  value: number;
  tone?: Tone;
  indeterminate?: boolean;
}) {
  return (
    <div
      className={`progress progress-${tone}${indeterminate ? ' indeterminate' : ''}`}
      role="progressbar"
      aria-valuenow={Math.round(value * 100)}
    >
      <div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export function Empty({ icon = 'check', children }: { icon?: IconName; children: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={32} />
      <div>{children}</div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden />;
}

/** Popover menu anchored to a button (closes on outside click / Escape; ↑/↓ move, focus returns to the button). */
export function MenuButton({
  label,
  icon,
  items,
  variant = 'secondary',
  small,
  disabled,
}: {
  label: string;
  icon?: IconName;
  items: { label: string; onClick: () => void }[];
  variant?: BtnProps['variant'];
  small?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        ref.current?.querySelector<HTMLElement>('button')?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
        next?.focus();
      } else if (e.key === 'Tab') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <Button
        variant={variant}
        icon={icon}
        small={small}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
        <Icon name="chevronDown" size={14} />
      </Button>
      {open ? (
        <div className="menu" role="menu">
          {items.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                ref.current?.querySelector<HTMLElement>('button')?.focus();
                i.onClick();
              }}
            >
              {i.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Pause with durations or resume. Global (default): timed pauses are tracked by the main process. With `target`
 * (an account or a pair) the daemon's own timer resumes it (`until`), like `nucleon-sync pause --account X --for 1h`.
 */
export function PauseControl({
  paused,
  small,
  disabled,
  target,
}: {
  paused: boolean;
  small?: boolean;
  disabled?: boolean;
  target?: { scope: 'account' | 'pair'; id: string | number };
}) {
  const run = (d: Parameters<typeof pauseFor>[0]) => {
    if (!target) return void pauseFor(d);
    if (d === 'resume') return void api.resume(target).catch(toastError);
    let until: Date | null = null;
    if (typeof d === 'number') until = new Date(Date.now() + d * 60_000);
    if (d === 'tomorrow') {
      until = new Date();
      until.setDate(until.getDate() + 1);
      until.setHours(7, 0, 0, 0);
    }
    void api.pause({ ...target, ...(until ? { until: until.toISOString() } : {}) }).catch(toastError);
  };
  if (paused)
    return (
      <Button icon="play" small={small} disabled={disabled} onClick={() => run('resume')}>
        {t.actions.resume}
      </Button>
    );
  return (
    <MenuButton
      label={t.actions.pause}
      icon="pause"
      small={small}
      disabled={disabled}
      items={[
        { label: t.actions.pause1h, onClick: () => run(60) },
        { label: t.actions.pauseTomorrow, onClick: () => run('tomorrow') },
        { label: t.actions.pauseForever, onClick: () => run(null) },
        {
          label: t.actions.pauseNow,
          onClick: () => void api.pause({ ...(target ?? { scope: 'all' }), immediate: true }).catch(toastError),
        },
      ]}
    />
  );
}
