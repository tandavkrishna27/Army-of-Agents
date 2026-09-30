import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/**
 * useTypewriter — types `text` out one character at a time via a setTimeout
 * sequencer (default 55ms/char, matching the splash/boot copy cadence).
 * Under `prefers-reduced-motion: reduce`, returns the full string
 * immediately — no incremental reveal.
 */
export function useTypewriter(text: string, msPerChar = 55): string {
  const reduce = usePrefersReducedMotion();
  const [out, setOut] = useState(() => (reduce ? text : ""));

  useEffect(() => {
    if (reduce) {
      setOut(text);
      return;
    }
    setOut("");
    let i = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      i += 1;
      setOut(text.slice(0, i));
      if (i < text.length) {
        timer = setTimeout(step, msPerChar);
      }
    };
    timer = setTimeout(step, msPerChar);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [text, reduce, msPerChar]);

  return out;
}
