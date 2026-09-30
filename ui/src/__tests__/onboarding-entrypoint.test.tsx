import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { DialogProvider, useDialog } from "../context/DialogContext";

/**
 * C13: the dialog-based OnboardingWizard is deleted; onboarding is the
 * FlowEngine mounted at /onboarding. The dialog context must no longer expose
 * the onboarding-modal surface — every entrypoint navigates to /onboarding.
 */
describe("onboarding entrypoint (C13)", () => {
  it("no longer exposes the onboarding-modal surface on the dialog context", () => {
    const { result } = renderHook(() => useDialog(), {
      wrapper: ({ children }) => <DialogProvider>{children}</DialogProvider>,
    });
    const ctx = result.current as Record<string, unknown>;
    expect(ctx.openOnboarding).toBeUndefined();
    expect(ctx.onboardingOpen).toBeUndefined();
    expect(ctx.closeOnboarding).toBeUndefined();
  });
});
