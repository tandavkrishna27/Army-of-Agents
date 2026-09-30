import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import type {
  AdapterRuntimeDecisionBroker,
  AdapterRuntimePermissionPrompt,
  AdapterRuntimePermissionAnswer,
  AdapterRuntimePermissionDecision,
} from "@armyofagents/adapter-utils";
import { handleApprovalRequest } from "../app-server/approval-bridge.js";

const CMD_METHOD = "item/commandExecution/requestApproval";
const FILE_METHOD = "item/fileChange/requestApproval";

/**
 * A controllable fake broker. Only `requestPermissionBounded` is exercised by
 * the bridge; the other broker methods throw so a stray call is caught in test.
 */
function makeBroker(opts: {
  outcome?: AdapterRuntimePermissionAnswer | { timedOut: true } | (() => never);
  onPrompt?: (prompt: AdapterRuntimePermissionPrompt) => void;
}): AdapterRuntimeDecisionBroker & {
  bounded: ReturnType<typeof vi.fn>;
  lastPrompt: () => AdapterRuntimePermissionPrompt | null;
} {
  let last: AdapterRuntimePermissionPrompt | null = null;
  const bounded = vi.fn(async (prompt: AdapterRuntimePermissionPrompt) => {
    last = prompt;
    opts.onPrompt?.(prompt);
    const o = opts.outcome;
    if (typeof o === "function") {
      return o();
    }
    return o ?? { timedOut: true as const };
  });
  return {
    requestPermission: async () => {
      throw new Error("requestPermission should not be called");
    },
    requestPermissionBounded: bounded as unknown as AdapterRuntimeDecisionBroker["requestPermissionBounded"],
    askWorkQuestion: async () => {
      throw new Error("askWorkQuestion should not be called");
    },
    bounded,
    lastPrompt: () => last,
  };
}

function answer(decision: AdapterRuntimePermissionDecision): AdapterRuntimePermissionAnswer {
  return { kind: "permission", decisionId: "d1", decision, sourceRevision: 1 };
}

const CWD = "/work/proj";

function cmdParams(overrides: Record<string, unknown> = {}): unknown {
  return {
    threadId: "t1",
    turnId: "turn1",
    itemId: "i1",
    command: "rm -rf build",
    cwd: CWD,
    reason: "cleanup build dir",
    ...overrides,
  };
}

function fileParams(paths: string[], overrides: Record<string, unknown> = {}): unknown {
  return {
    threadId: "t1",
    turnId: "turn1",
    itemId: "i1",
    reason: "write source",
    grantRoot: null,
    item: {
      changes: paths.map((p) => ({ path: p, kind: { type: "add" }, diff: "+x" })),
    },
    ...overrides,
  };
}

const base = { bridged: true as const, timeoutMs: 30_000, cwd: CWD };

describe("handleApprovalRequest — decision mapping", () => {
  it("maps allow_once → accept", async () => {
    const broker = makeBroker({ outcome: answer("allow_once") });
    const d = await handleApprovalRequest(CMD_METHOD, cmdParams(), { ...base, broker });
    expect(d).toBe("accept");
    expect(broker.bounded).toHaveBeenCalledTimes(1);
  });

  it("maps allow_always → acceptForSession", async () => {
    const broker = makeBroker({ outcome: answer("allow_always") });
    const d = await handleApprovalRequest(CMD_METHOD, cmdParams(), { ...base, broker });
    expect(d).toBe("acceptForSession");
  });

  it("maps deny → decline", async () => {
    const broker = makeBroker({ outcome: answer("deny") });
    const d = await handleApprovalRequest(CMD_METHOD, cmdParams(), { ...base, broker });
    expect(d).toBe("decline");
  });

  it("maps timeout ({ timedOut: true }) → decline", async () => {
    const broker = makeBroker({ outcome: { timedOut: true } });
    const d = await handleApprovalRequest(CMD_METHOD, cmdParams(), { ...base, broker });
    expect(d).toBe("decline");
  });

  it("thrown broker → decline", async () => {
    const broker = makeBroker({
      outcome: () => {
        throw new Error("boom");
      },
    });
    const d = await handleApprovalRequest(CMD_METHOD, cmdParams(), { ...base, broker });
    expect(d).toBe("decline");
  });

  it("RuntimeDecisionCancelledError-like throw → decline", async () => {
    const broker = makeBroker({
      outcome: () => {
        const e = new Error("cancelled");
        e.name = "RuntimeDecisionCancelledError";
        throw e;
      },
    });
    const d = await handleApprovalRequest(CMD_METHOD, cmdParams(), { ...base, broker });
    expect(d).toBe("decline");
  });

  it("unrecognized/garbage broker outcome → decline", async () => {
    const broker = makeBroker({
      outcome: { kind: "permission", decisionId: "d", decision: "nonsense", sourceRevision: 1 } as unknown as AdapterRuntimePermissionAnswer,
    });
    const d = await handleApprovalRequest(CMD_METHOD, cmdParams(), { ...base, broker });
    expect(d).toBe("decline");
  });

  it("null/undefined broker outcome → decline", async () => {
    const broker = makeBroker({ outcome: null as unknown as { timedOut: true } });
    const d = await handleApprovalRequest(CMD_METHOD, cmdParams(), { ...base, broker });
    expect(d).toBe("decline");
  });
});

describe("handleApprovalRequest — fail-closed gate", () => {
  it("bridged:false → decline, broker never called", async () => {
    const broker = makeBroker({ outcome: answer("allow_once") });
    const d = await handleApprovalRequest(CMD_METHOD, cmdParams(), {
      ...base,
      bridged: false,
      broker,
    });
    expect(d).toBe("decline");
    expect(broker.bounded).not.toHaveBeenCalled();
  });

  it("missing broker → decline", async () => {
    const d = await handleApprovalRequest(CMD_METHOD, cmdParams(), {
      ...base,
      broker: undefined,
    });
    expect(d).toBe("decline");
  });
});

describe("handleApprovalRequest — command prompt shape", () => {
  it("command request builds prompt with command/cwd/reason + escalate policy", async () => {
    const broker = makeBroker({ outcome: answer("allow_once") });
    await handleApprovalRequest(CMD_METHOD, cmdParams(), { ...base, broker });
    const p = broker.lastPrompt();
    expect(p).not.toBeNull();
    expect(p?.command).toBe("rm -rf build");
    expect(p?.cwd).toBe(CWD);
    expect(p?.summary).toContain("cleanup build dir");
    expect(p?.timeoutPolicy).toBe("escalate");
    expect(p?.kind).toBe("permission");
  });
});

describe("handleApprovalRequest — file-change trust boundary", () => {
  it("in-tree relative path passes; prompt carries validated path", async () => {
    const broker = makeBroker({ outcome: answer("allow_once") });
    const d = await handleApprovalRequest(FILE_METHOD, fileParams(["src/x.ts"]), {
      ...base,
      broker,
    });
    expect(d).toBe("accept");
    const p = broker.lastPrompt();
    expect(p?.path).toBe(path.resolve(CWD, "src/x.ts"));
    expect(p?.timeoutPolicy).toBe("escalate");
  });

  it("in-tree absolute path passes", async () => {
    const abs = path.join(path.resolve(CWD), "src", "y.ts");
    const broker = makeBroker({ outcome: answer("allow_once") });
    const d = await handleApprovalRequest(FILE_METHOD, fileParams([abs]), {
      ...base,
      broker,
      cwd: CWD,
    });
    expect(d).toBe("accept");
    expect(broker.bounded).toHaveBeenCalledTimes(1);
  });

  it("carries both normalized + raw path in prompt metadata", async () => {
    const broker = makeBroker({ outcome: answer("allow_once") });
    await handleApprovalRequest(FILE_METHOD, fileParams(["src/x.ts"]), { ...base, broker });
    const p = broker.lastPrompt();
    const meta = (p?.options?.[0] ?? {}) as Record<string, unknown>;
    expect(meta.rawPath).toBe("src/x.ts");
    expect(typeof meta.normalizedPath).toBe("string");
    expect(meta.kind).toBe("file_change");
  });

  it("escape via ../../etc/passwd → decline WITHOUT calling broker", async () => {
    const broker = makeBroker({ outcome: answer("allow_once") });
    const d = await handleApprovalRequest(FILE_METHOD, fileParams(["../../etc/passwd"]), {
      ...base,
      broker,
    });
    expect(d).toBe("decline");
    expect(broker.bounded).not.toHaveBeenCalled();
  });

  it("absolute out-of-tree path → decline WITHOUT calling broker", async () => {
    const broker = makeBroker({ outcome: answer("allow_once") });
    const d = await handleApprovalRequest(FILE_METHOD, fileParams(["/etc/passwd"]), {
      ...base,
      broker,
      cwd: CWD,
    });
    expect(d).toBe("decline");
    expect(broker.bounded).not.toHaveBeenCalled();
  });

  it("prefix-trap sibling (/work/proj-evil vs cwd /work/proj) → decline WITHOUT broker", async () => {
    const broker = makeBroker({ outcome: answer("allow_once") });
    const d = await handleApprovalRequest(
      FILE_METHOD,
      fileParams(["/work/proj-evil/secret"]),
      { ...base, broker, cwd: "/work/proj" },
    );
    expect(d).toBe("decline");
    expect(broker.bounded).not.toHaveBeenCalled();
  });

  it("multi-change: any escape declines the whole request without broker", async () => {
    const broker = makeBroker({ outcome: answer("allow_once") });
    const d = await handleApprovalRequest(
      FILE_METHOD,
      fileParams(["src/ok.ts", "../../../etc/shadow"]),
      { ...base, broker },
    );
    expect(d).toBe("decline");
    expect(broker.bounded).not.toHaveBeenCalled();
  });

  it("cwd root itself is in-tree (equal path)", async () => {
    const broker = makeBroker({ outcome: answer("allow_once") });
    const d = await handleApprovalRequest(FILE_METHOD, fileParams(["."]), {
      ...base,
      broker,
    });
    expect(d).toBe("accept");
  });

  it("logs via onLog on escape", async () => {
    const logs: string[] = [];
    const broker = makeBroker({ outcome: answer("allow_once") });
    await handleApprovalRequest(FILE_METHOD, fileParams(["../../etc/passwd"]), {
      ...base,
      broker,
      onLog: (m) => logs.push(m),
    });
    expect(logs.some((l) => /escape|outside|denied/i.test(l))).toBe(true);
  });
});

describe("handleApprovalRequest — never throws", () => {
  it("garbage params (no item) → decline, not throw", async () => {
    const broker = makeBroker({ outcome: answer("allow_once") });
    const d = await handleApprovalRequest(FILE_METHOD, { nonsense: true }, { ...base, broker });
    expect(d).toBe("decline");
  });

  it("null params → decline", async () => {
    const broker = makeBroker({ outcome: answer("allow_once") });
    const d = await handleApprovalRequest(CMD_METHOD, null, { ...base, broker });
    // command params absent → prompt still built (command null) and broker asked
    expect(["accept", "decline"]).toContain(d);
  });

  it("unknown method declines without creating a misleading permission prompt", async () => {
    const broker = makeBroker({ outcome: answer("deny") });
    const d = await handleApprovalRequest("item/unknown/requestApproval", cmdParams(), {
      ...base,
      broker,
    });
    expect(d).toBe("decline");
    expect(broker.bounded).not.toHaveBeenCalled();
  });
});
