/**
 * Tests for resolveDeliverableWorkspaceMode (P1-T8 slice 3).
 *
 * Pure function — no mocking required.
 */

import { describe, it, expect } from "vitest";
import { resolveDeliverableWorkspaceMode } from "../services/execution-workspace-policy.ts";

describe("resolveDeliverableWorkspaceMode — isolated intent", () => {
  it('returns "isolated" when intent is explicitly "isolated"', () => {
    expect(
      resolveDeliverableWorkspaceMode({ intent: "isolated", threadHasWorkspace: false }),
    ).toBe("isolated");
  });

  it('returns "isolated" regardless of threadHasWorkspace when intent is "isolated"', () => {
    expect(
      resolveDeliverableWorkspaceMode({ intent: "isolated", threadHasWorkspace: true }),
    ).toBe("isolated");
    expect(
      resolveDeliverableWorkspaceMode({ intent: "isolated", threadHasWorkspace: false }),
    ).toBe("isolated");
  });
});

describe("resolveDeliverableWorkspaceMode — reuse intent", () => {
  it('returns "reuse_thread" when intent is explicitly "reuse"', () => {
    expect(
      resolveDeliverableWorkspaceMode({ intent: "reuse", threadHasWorkspace: true }),
    ).toBe("reuse_thread");
  });

  it('returns "reuse_thread" when intent is "reuse" and thread has no workspace yet', () => {
    expect(
      resolveDeliverableWorkspaceMode({ intent: "reuse", threadHasWorkspace: false }),
    ).toBe("reuse_thread");
  });
});

describe("resolveDeliverableWorkspaceMode — default (no intent)", () => {
  it('defaults to "reuse_thread" when intent is absent', () => {
    expect(
      resolveDeliverableWorkspaceMode({ threadHasWorkspace: true }),
    ).toBe("reuse_thread");
  });

  it('defaults to "reuse_thread" when intent is absent and thread has no workspace', () => {
    expect(
      resolveDeliverableWorkspaceMode({ threadHasWorkspace: false }),
    ).toBe("reuse_thread");
  });
});

describe("resolveDeliverableWorkspaceMode — threadHasWorkspace has no effect on mode", () => {
  it('both threadHasWorkspace values yield "reuse_thread" for reuse intent', () => {
    const withWorkspace    = resolveDeliverableWorkspaceMode({ intent: "reuse",     threadHasWorkspace: true  });
    const withoutWorkspace = resolveDeliverableWorkspaceMode({ intent: "reuse",     threadHasWorkspace: false });
    const defaultWith      = resolveDeliverableWorkspaceMode({                      threadHasWorkspace: true  });
    const defaultWithout   = resolveDeliverableWorkspaceMode({                      threadHasWorkspace: false });

    expect(withWorkspace).toBe("reuse_thread");
    expect(withoutWorkspace).toBe("reuse_thread");
    expect(defaultWith).toBe("reuse_thread");
    expect(defaultWithout).toBe("reuse_thread");
  });

  it('both threadHasWorkspace values yield "isolated" for isolated intent', () => {
    const withWorkspace    = resolveDeliverableWorkspaceMode({ intent: "isolated", threadHasWorkspace: true  });
    const withoutWorkspace = resolveDeliverableWorkspaceMode({ intent: "isolated", threadHasWorkspace: false });

    expect(withWorkspace).toBe("isolated");
    expect(withoutWorkspace).toBe("isolated");
  });
});
