'use client';
/**
 * office-view/react/useAnimationLoop — the single requestAnimationFrame loop.
 *
 * One loop for the whole office. It is the only thing allowed to run at 60fps, and it
 * must never call `setState`: it writes transforms straight onto DOM nodes through a ref
 * registry. The moment a frame causes a React render, the architecture is defeated and
 * the office starts dropping frames on a phone.
 *
 * The callback receives real elapsed milliseconds. What the scene does with them (scale
 * by playback rate, ignore while paused) is the clock's business, not the loop's — which
 * is what keeps the clock deterministic and testable without a browser.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * @param onFrame called once per animation frame with elapsed ms since the last frame
 * @param enabled pause the loop entirely (nothing is running, or the tab is hidden)
 */
export function useAnimationLoop(onFrame: (deltaMs: number) => void, enabled = true): void {
  // Held in a ref so a changing callback identity never restarts the loop. Restarting
  // would drop a frame and, worse, reset the delta baseline. Assigned in an effect
  // rather than during render, because mutating a ref while rendering is not safe under
  // concurrent React.
  const callback = useRef(onFrame);
  useEffect(() => {
    callback.current = onFrame;
  });

  useEffect(() => {
    if (!enabled) return;

    let frame = 0;
    let last: number | null = null;

    const tick = (now: number) => {
      // The first frame has no baseline, so it contributes no elapsed time.
      const delta = last === null ? 0 : now - last;
      last = now;
      // Clamp: a backgrounded tab hands back a delta of many seconds on return, which
      // would teleport everything. Capping means the office resumes rather than jumps.
      callback.current(Math.min(delta, 100));
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [enabled]);
}

/**
 * True when the viewer has asked for reduced motion.
 *
 * The office honours this by cutting between states rather than travelling between them:
 * the scene stays completely truthful, it just stops moving.
 */
export function usePrefersReducedMotion(): boolean {
  // useSyncExternalStore rather than an effect that calls setState: the media query is
  // an external store, and subscribing to it directly avoids the cascading render that
  // "read it in an effect, then set state" causes.
  return useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    // Server snapshot: assume motion is fine, then correct on hydration.
    () => false,
  );
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Container size, for positioning the HTML label overlay over the SVG.
 *
 * Labels are HTML rather than SVG `<text>` so they inherit the app's real type system —
 * font stack, wrapping, truncation — instead of a parallel one that never quite matches.
 */
export function useElementSize<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  { width: number; height: number },
] {
  const ref = useRef<T>(null);
  /**
   * The last size we told React about. Held in a ref so the snapshot keeps a stable
   * identity between reads — `useSyncExternalStore` compares by reference, and returning a
   * fresh object every time would loop forever.
   */
  const snapshot = useRef({ width: 0, height: 0 });

  const subscribe = useCallback((onChange: () => void) => {
    const element = ref.current;
    if (!element) return () => {};

    const read = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width === snapshot.current.width && rect.height === snapshot.current.height) {
        return;
      }
      snapshot.current = { width: rect.width, height: rect.height };
      onChange();
    };

    /*
     * Measure once, immediately, rather than waiting to be told.
     *
     * ResizeObserver is *supposed* to deliver an initial entry on observe(), and usually
     * does. Depending on that alone means that anywhere it does not — an element observed
     * while the viewport is still collapsing, an embedded or emulated browser — the office
     * renders no labels at all and looks broken rather than empty. Measuring first costs
     * one layout read and removes a whole class of "why is it blank".
     */
    read();

    if (typeof ResizeObserver === 'undefined') {
      // Older or restricted environments still get resize handling, just coarser.
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }

    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const getSnapshot = useCallback(() => snapshot.current, []);
  const size = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return [ref, size];
}
