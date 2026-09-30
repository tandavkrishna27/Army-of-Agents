import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useInView — a small `IntersectionObserver` hook, matching the site's
 * `useInView` grammar (Codex P2: CSS alone can't do in-view triggering).
 * Returns a `[ref, inView]` tuple: attach `ref` to the element to observe.
 *
 * `once`: stop observing (and freeze `inView` at `true`) after the first
 * intersection. `margin`: the observer's `rootMargin` (e.g. "-100px" to
 * trigger the reveal slightly before the element is fully on-screen).
 */
export function useInView({ once = false, margin = "0px" }: { once?: boolean; margin?: string } = {}) {
  const [inView, setInView] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elRef = useRef<Element | null>(null);

  const ref = useCallback(
    (node: Element | null) => {
      if (observerRef.current && elRef.current) {
        observerRef.current.unobserve(elRef.current);
      }
      elRef.current = node;
      if (!node) return;

      if (!observerRef.current) {
        observerRef.current = new IntersectionObserver(
          (entries) => {
            const entry = entries[0];
            if (entry?.isIntersecting) {
              setInView(true);
              if (once) observerRef.current?.disconnect();
            } else if (!once) {
              setInView(false);
            }
          },
          { rootMargin: margin },
        );
      }
      observerRef.current.observe(node);
    },
    [once, margin],
  );

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
    };
  }, []);

  return [ref, inView] as const;
}
