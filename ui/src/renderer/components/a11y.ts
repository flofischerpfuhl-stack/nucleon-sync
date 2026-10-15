// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Keyboard helpers: focus trap for dialogs, arrow-key navigation in lists/trees, the global shortcut table.
 * Everything in the app is reachable with Tab / Shift+Tab; these make it fast (default keyboard-driven UI).
 */
import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Keeps Tab inside `ref` while active and restores the previous focus afterwards. Focuses `initial` (or the
 * first focusable element) when it opens.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  initial?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!active) return;
    const before = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (!root) return;
    (initial?.current ?? focusables(root)[0] ?? root).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = focusables(root);
      if (!list.length) return;
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const cur = document.activeElement as HTMLElement | null;
      if (!root.contains(cur)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && cur === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (before && document.contains(before)) before.focus();
    };
  }, [active]);
}

/**
 * Arrow-key navigation over rows: ↑/↓ (and Home/End) move the focus to the same control of the previous/next row,
 * → / ← call `expand` / `collapse` of the row (trees). Attach to the list container's onKeyDown.
 */
export function rowKeys(
  e: ReactKeyboardEvent<HTMLElement>,
  o: { row: string; target: string; expand?: (row: HTMLElement) => void; collapse?: (row: HTMLElement) => void },
): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const container = e.currentTarget;
  const rows = [...container.querySelectorAll<HTMLElement>(o.row)];
  const cur = (e.target as HTMLElement).closest<HTMLElement>(o.row);
  if (!cur) return;
  const i = rows.indexOf(cur);
  const focusRow = (r: HTMLElement | undefined) => {
    const el = r?.querySelector<HTMLElement>(o.target) ?? r?.querySelector<HTMLElement>(FOCUSABLE);
    if (el) {
      e.preventDefault();
      el.focus();
      el.scrollIntoView({ block: 'nearest' });
    }
  };
  if (e.key === 'ArrowDown') focusRow(rows[i + 1]);
  else if (e.key === 'ArrowUp') focusRow(rows[i - 1]);
  else if (e.key === 'Home') focusRow(rows[0]);
  else if (e.key === 'End') focusRow(rows[rows.length - 1]);
  else if (e.key === 'ArrowRight' && o.expand) {
    e.preventDefault();
    o.expand(cur);
  } else if (e.key === 'ArrowLeft' && o.collapse) {
    e.preventDefault();
    o.collapse(cur);
  }
}

/** true while the user types in a field (global single-key shortcuts are off then) */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(type);
  }
  return el.isContentEditable;
}

/** Global shortcuts (also listed in the help overlay). Screens are 1–8 in sidebar order, also with Alt. */
export const SHORTCUTS = {
  help: ['?'],
  sync: ['s'],
  pause: ['p'],
  search: ['/', 'Ctrl+F'],
  newPair: ['n'],
  refresh: ['r', 'F5'],
} as const;

/** custom DOM events screens listen to */
export const KEY_EVENTS = { search: 'ps:search', newPair: 'ps:new-pair' } as const;

/** Opens the pair wizard on the Folders screen, also when that screen is not mounted yet (it picks the flag up). */
let pendingNewPair = false;
export function requestNewPair(): void {
  pendingNewPair = true;
  window.dispatchEvent(new Event(KEY_EVENTS.newPair));
}
export function takePendingNewPair(): boolean {
  const p = pendingNewPair;
  pendingNewPair = false;
  return p;
}
