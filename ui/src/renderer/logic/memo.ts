// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Selector memoisation for the external store (useSyncExternalStore requires a stable snapshot: a selector like
 * `s => s.status?.accounts ?? []` returns a new array on every call and makes React loop, "Maximum update depth
 * exceeded" → blank window). The result is reused while the state object is the same, and also when a new state
 * yields a shallowly equal result. Pure; unit-tested.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => Object.is(x, bb[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every(
      (k) => Object.hasOwn(b, k) && Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}

/**
 * Returns `(state, selector) => value`: recomputes when the state or the selector function changed (inline selectors
 * change every render, e.g. when they close over an id) but returns the previous value while the new one is
 * shallowly equal, so getSnapshot stays stable.
 */
export function memoSelector<S, T>(): (state: S, selector: (s: S) => T) => T {
  let has = false;
  let lastState: S;
  let lastSelector: (s: S) => T;
  let lastValue: T;
  return (state, selector) => {
    if (has && Object.is(state, lastState) && selector === lastSelector) return lastValue;
    const v = selector(state);
    if (!has || !shallowEqual(v, lastValue)) lastValue = v;
    lastState = state;
    lastSelector = selector;
    has = true;
    return lastValue;
  };
}
