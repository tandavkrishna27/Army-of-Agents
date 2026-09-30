import { describe, it, expect } from "vitest";
import * as motion from "../index";

describe("motion barrel", () => {
  it("re-exports every WS1 primitive and hook", () => {
    expect(motion.AoaLogo).toBeTypeOf("function");
    expect(motion.ConstellationBg).toBeTypeOf("function");
    expect(motion.AgentCharacter).toBeTypeOf("function");
    expect(motion.LoadingDots).toBeTypeOf("function");
    expect(motion.Reveal).toBeTypeOf("function");
    expect(motion.DrawOnMap).toBeTypeOf("function");
    expect(motion.usePrefersReducedMotion).toBeTypeOf("function");
    expect(motion.useInView).toBeTypeOf("function");
    expect(motion.useTypewriter).toBeTypeOf("function");
  });
});
