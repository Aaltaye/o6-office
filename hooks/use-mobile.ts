import * as React from 'react';

const MOBILE_BREAKPOINT = 768;
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

/**
 * Subscribe to the viewport being phone-width.
 *
 * `useSyncExternalStore` rather than state-plus-effect. The media query IS the store, so
 * copying it into React state means keeping a duplicate in sync with something that can
 * change without telling React — the class of bug this hook exists to avoid. It also
 * yields a real value on the first render instead of `undefined`, so the first paint is
 * not silently "desktop" until an effect corrects it.
 */
export function useIsMobile(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

/**
 * There is no viewport on the server, and guessing one would make the server markup
 * disagree with the first client render. Desktop is the safer default: the mobile branch
 * swaps in a compact floor plan, and showing that to a desktop visitor is the more
 * visible error of the two.
 */
function getServerSnapshot(): boolean {
  return false;
}
