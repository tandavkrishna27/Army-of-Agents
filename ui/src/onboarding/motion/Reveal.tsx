import type { CSSProperties, ElementType, ReactNode } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { useInView } from "./useInView";

/**
 * Reveal — the site's signature fade-up-on-mount wrapper (`obd-fadeUp`,
 * 0.7s, `cubic-bezier(.16,.8,.3,1)`), staggered via `delay` (seconds).
 *
 * Reduced motion is decided in JS, NOT CSS (jsdom doesn't apply
 * `@media prefers-reduced-motion` to computed styles, and a direct
 * component test never loads motion.css — so a CSS-only override is
 * neither reliable nor testable). Under reduced motion, renders the bare
 * tag: no animation, no `opacity:0` start state.
 */
export function Reveal({
  children,
  delay = 0,
  as,
  inView = false,
}: {
  children: ReactNode;
  delay?: number;
  as?: ElementType;
  inView?: boolean;
}) {
  const Tag = as ?? "div";
  const reduce = usePrefersReducedMotion();

  if (reduce) return <Tag>{children}</Tag>;

  const anim: CSSProperties = {
    opacity: 0,
    transform: "translateY(24px)",
    animation: "obd-fadeUp .7s cubic-bezier(.16,.8,.3,1) forwards",
    animationDelay: `${delay}s`,
  };

  if (!inView) return <Tag style={anim}>{children}</Tag>;

  return (
    <RevealInView Tag={Tag} anim={anim}>
      {children}
    </RevealInView>
  );
}

/**
 * Attaches `anim` (the animated, visible-end state) only once the wrapped
 * element scrolls into view (via `useInView`); before that it renders the
 * hidden start state so there's no flash of animated content off-screen.
 */
function RevealInView({
  Tag,
  anim,
  children,
}: {
  Tag: ElementType;
  anim: CSSProperties;
  children: ReactNode;
}) {
  const [ref, visible] = useInView({ once: true, margin: "-100px" });
  const hidden: CSSProperties = { opacity: 0, transform: "translateY(24px)" };
  return (
    <Tag ref={ref} style={visible ? anim : hidden}>
      {children}
    </Tag>
  );
}
