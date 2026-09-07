'use client';
/**
 * office-view/react/useDismissed — clearing finished agents off the floor.
 *
 * Agents that have finished stay at the desk they used, so what they did can still be read
 * off the floor. Over a long session that accumulates, so a viewer needs to be able to
 * clear them away — and the clearing has to be honest about itself.
 *
 * Two rules, and the second is the one that matters:
 *
 *  1. It hides records and NOTHING else. The event stream, the schedule, the operations
 *     log, the artifacts and every token total are untouched. Discarding changes what you
 *     are looking at, never what happened.
 *  2. The count of what has been cleared is always stated, and clearing is always
 *     reversible. An office that quietly reported less after you tidied it would be the
 *     same class of lie as a truncated list that does not admit it is truncated — and this
 *     project's whole claim is that what you see is what happened.
 *
 * Scoped per plan and per run, so tidying one recording does not tidy another.
 * sessionStorage rather than localStorage: this is a convenience for the sitting you are
 * in, not a preference worth keeping forever.
 *
 * Built on `useSyncExternalStore` for the same reason `useElementSize` is: the value lives
 * outside React (in storage), the first client render has to match the server's HTML, and
 * reading it into state from an effect causes exactly the cascading render the compiler
 * warns about.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';

export type Dismissed = {
  /** The workers currently hidden. */
  dismissed: ReadonlySet<string>;
  /** Hide one finished agent's record. */
  dismiss: (worker: string) => void;
  /** Hide every finished agent named. */
  dismissAll: (workers: readonly string[]) => void;
  /** Put everything back. Offered whenever anything is hidden. */
  restoreAll: () => void;
};

/** Nothing hidden. A shared instance, so an unchanged snapshot is reference-equal. */
const EMPTY: ReadonlySet<string> = new Set();

/**
 * The store, keyed by scope.
 *
 * Kept outside React because storage is: a snapshot has to be stable between renders or
 * `useSyncExternalStore` will loop, so the parsed Set is cached and only replaced when it
 * actually changes.
 */
const snapshots = new Map<string, ReadonlySet<string>>();
const listeners = new Map<string, Set<() => void>>();

/**
 * Storage access is wrapped because it is not always there to be had — a private window, a
 * browser told to block site data, or a thumbnail capture will throw on access rather than
 * return nothing. A viewer without storage still gets working discard; it just does not
 * outlive the tab.
 */
function load(key: string): ReadonlySet<string> {
  try {
    const raw = window.sessionStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return EMPTY;
    const ids = parsed.filter((id): id is string => typeof id === 'string');
    return ids.length ? new Set(ids) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function snapshotOf(key: string): ReadonlySet<string> {
  const cached = snapshots.get(key);
  if (cached) return cached;
  const loaded = load(key);
  snapshots.set(key, loaded);
  return loaded;
}

function publish(key: string, next: ReadonlySet<string>): void {
  snapshots.set(key, next);
  try {
    window.sessionStorage.setItem(key, JSON.stringify([...next]));
  } catch {
    // Not worth surfacing: the feature works, it just will not survive a reload.
  }
  for (const listener of listeners.get(key) ?? []) listener();
}

export function useDismissed(scope: string): Dismissed {
  const key = `o6-office:dismissed:${scope}`;

  const subscribe = useCallback(
    (onChange: () => void) => {
      const set = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, set);
      set.add(onChange);
      return () => set.delete(onChange);
    },
    [key],
  );

  const dismissed = useSyncExternalStore(
    subscribe,
    () => snapshotOf(key),
    // The server has no storage and must render the untidied office, which is also what
    // the client's first paint has to show for hydration to match.
    () => EMPTY,
  );

  const dismiss = useCallback(
    (worker: string) => publish(key, new Set([...snapshotOf(key), worker])),
    [key],
  );

  const dismissAll = useCallback(
    (workers: readonly string[]) => publish(key, new Set([...snapshotOf(key), ...workers])),
    [key],
  );

  const restoreAll = useCallback(() => publish(key, EMPTY), [key]);

  return useMemo(
    () => ({ dismissed, dismiss, dismissAll, restoreAll }),
    [dismissed, dismiss, dismissAll, restoreAll],
  );
}
