import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runtimeHooksRoutes } from "../routes/runtime-hooks.js";
import {
  registerRuntimeHook,
  deregisterRuntimeHook,
  mintRuntimeHookToken,
  type RuntimeHookEntry,
} from "../services/runtime-hook-registry.js";
import { RUNTIME_HOOK_PATH } from "@armyofagents/adapter-utils";
import type {
  AdapterRuntimeDecisionBroker,
  AdapterRuntimePermissionAnswer,
} from "@armyofagents/adapter-utils";
import { errorHandler } from "../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  // The router self-registers the full RUNTIME_HOOK_PATH, so mount at root
  // (mirrors app.ts, which mounts app.use(runtimeHooksRoutes(db)) outside /api).
  app.use(runtimeHooksRoutes({} as never));
  app.use(errorHandler);
  return app;
}

/**
 * A stub broker whose requestPermissionBounded returns a pre-scripted value.
 * requestPermission/askWorkQuestion are unused by the route.
 */
function makeBroker(
  impl: AdapterRuntimeDecisionBroker["requestPermissionBounded"],
): AdapterRuntimeDecisionBroker {
  return {
    requestPermission: vi.fn(),
    askWorkQuestion: vi.fn(),
    requestPermissionBounded: impl,
  } as unknown as AdapterRuntimeDecisionBroker;
}

function permissionAnswer(
  decision: AdapterRuntimePermissionAnswer["decision"],
): AdapterRuntimePermissionAnswer {
  return { kind: "permission", decisionId: "dec-1", decision, sourceRevision: 1 };
}

const registeredTokens: string[] = [];

function register(
  overrides: Partial<RuntimeHookEntry> & { broker: AdapterRuntimeDecisionBroker },
): string {
  const token = mintRuntimeHookToken();
  registerRuntimeHook(token, {
    companyId: "company-A",
    agentId: "agent-A",
    runId: "run-A",
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });
  registeredTokens.push(token);
  return token;
}

const BASE_BODY = {
  session_id: "sess-1",
  cwd: "/tmp/work",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls -la" },
};

afterEach(() => {
  for (const token of registeredTokens.splice(0)) {
    deregisterRuntimeHook(token);
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Auth / fail-safe cases
// ---------------------------------------------------------------------------

describe("runtime-hooks route — auth fail-safe", () => {
  it("missing token → 200 deny, broker never called", async () => {
    const bounded = vi.fn();
    // A broker is registered under a different token; this request has none.
    register({ broker: makeBroker(bounded) });
    const res = await request(makeApp()).post(RUNTIME_HOOK_PATH).send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(bounded).not.toHaveBeenCalled();
  });

  it("invalid (too-short) token → 200 deny, broker never called", async () => {
    const bounded = vi.fn();
    register({ broker: makeBroker(bounded) });
    const res = await request(makeApp())
      .post(RUNTIME_HOOK_PATH)
      .set("Authorization", "Bearer short")
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(bounded).not.toHaveBeenCalled();
  });

  it("unknown token → 200 deny, broker never called", async () => {
    const bounded = vi.fn();
    register({ broker: makeBroker(bounded) });
    const unknown = mintRuntimeHookToken(); // valid shape, not registered
    const res = await request(makeApp())
      .post(RUNTIME_HOOK_PATH)
      .set("Authorization", `Bearer ${unknown}`)
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(bounded).not.toHaveBeenCalled();
  });

  it("expired token → 200 deny, broker never called", async () => {
    const bounded = vi.fn();
    const token = register({
      broker: makeBroker(bounded),
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await request(makeApp())
      .post(RUNTIME_HOOK_PATH)
      .set("Authorization", `Bearer ${token}`)
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(bounded).not.toHaveBeenCalled();
    void token;
  });
});

// ---------------------------------------------------------------------------
// Decision mapping cases
// ---------------------------------------------------------------------------

describe("runtime-hooks route — decision mapping", () => {
  it("allow_once → permissionDecision allow", async () => {
    const bounded = vi.fn().mockResolvedValue(permissionAnswer("allow_once"));
    const token = register({ broker: makeBroker(bounded) });
    const res = await request(makeApp())
      .post(RUNTIME_HOOK_PATH)
      .set("Authorization", `Bearer ${token}`)
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(bounded).toHaveBeenCalledTimes(1);
  });

  it("allow_always → permissionDecision allow", async () => {
    const bounded = vi.fn().mockResolvedValue(permissionAnswer("allow_always"));
    const token = register({ broker: makeBroker(bounded) });
    const res = await request(makeApp())
      .post(RUNTIME_HOOK_PATH)
      .set("Authorization", `Bearer ${token}`)
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("deny → permissionDecision deny", async () => {
    const bounded = vi.fn().mockResolvedValue(permissionAnswer("deny"));
    const token = register({ broker: makeBroker(bounded) });
    const res = await request(makeApp())
      .post(RUNTIME_HOOK_PATH)
      .set("Authorization", `Bearer ${token}`)
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("timed out → permissionDecision deny", async () => {
    const bounded = vi.fn().mockResolvedValue({ timedOut: true });
    const token = register({ broker: makeBroker(bounded) });
    const res = await request(makeApp())
      .post(RUNTIME_HOOK_PATH)
      .set("Authorization", `Bearer ${token}`)
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("broker throws → 200 deny (fail-safe)", async () => {
    const bounded = vi.fn().mockRejectedValue(new Error("boom"));
    const token = register({ broker: makeBroker(bounded) });
    const res = await request(makeApp())
      .post(RUNTIME_HOOK_PATH)
      .set("Authorization", `Bearer ${token}`)
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("payload companyId mismatch vs token entry → 200 deny, broker never called", async () => {
    const bounded = vi.fn();
    const token = register({ broker: makeBroker(bounded), companyId: "company-A" });
    const res = await request(makeApp())
      .post(RUNTIME_HOOK_PATH)
      .set("Authorization", `Bearer ${token}`)
      .send({ ...BASE_BODY, companyId: "company-OTHER" });
    expect(res.status).toBe(200);
    expect(res.body.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(bounded).not.toHaveBeenCalled();
  });

  it("matching companyId in payload → passes through to broker", async () => {
    const bounded = vi.fn().mockResolvedValue(permissionAnswer("allow_once"));
    const token = register({ broker: makeBroker(bounded), companyId: "company-A" });
    const res = await request(makeApp())
      .post(RUNTIME_HOOK_PATH)
      .set("Authorization", `Bearer ${token}`)
      .send({ ...BASE_BODY, companyId: "company-A" });
    expect(res.status).toBe(200);
    expect(res.body.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(bounded).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Adapter session gone: registered → deregistered → route must deny without
// calling the broker (the run ended before the hook arrived).
// ---------------------------------------------------------------------------

describe("runtime-hooks route — adapter session gone", () => {
  it("deregistered token → 200 deny, broker never called", async () => {
    // Simulate: heartbeat registered the token when the run started, then
    // deregistered it when the run ended. A late hook POST with that token
    // must be denied (resolveRuntimeHook returns null) and must never reach
    // the broker's requestPermissionBounded.
    const bounded = vi.fn();
    const token = register({ broker: makeBroker(bounded) });

    // Run ends → heartbeat calls deregisterRuntimeHook.
    deregisterRuntimeHook(token);
    // Remove from cleanup list since we already deregistered.
    const idx = registeredTokens.indexOf(token);
    if (idx !== -1) registeredTokens.splice(idx, 1);

    const res = await request(makeApp())
      .post(RUNTIME_HOOK_PATH)
      .set("Authorization", `Bearer ${token}`)
      .send(BASE_BODY);

    expect(res.status).toBe(200);
    expect(res.body.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(bounded).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Route-mount test: not swallowed by a static/SPA fallthrough
// ---------------------------------------------------------------------------

describe("runtime-hooks route — mounting", () => {
  it("POST /internal/runtime-hooks/permission-request is handled by this route (JSON, not HTML)", async () => {
    // Mimic app.ts ordering: mount /internal BEFORE a catch-all SPA handler.
    const bounded = vi.fn().mockResolvedValue(permissionAnswer("deny"));
    const token = register({ broker: makeBroker(bounded) });

    const app = express();
    app.use(express.json());
    app.use(runtimeHooksRoutes({} as never));
    // Catch-all SPA handler as in app.ts (would serve HTML if it won).
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.status(200).set("Content-Type", "text/html").send("<!doctype html><html></html>");
    });
    app.use(errorHandler);

    const res = await request(app)
      .post(RUNTIME_HOOK_PATH)
      .set("Authorization", `Bearer ${token}`)
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.hookSpecificOutput).toBeDefined();
    expect(res.body.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });
});
