/**
 * W5c Task 7 — the BRIDGED (supervised) codex execution path.
 *
 * When runtime-decision routing is enabled for a run (per-agent opt-in, local
 * target, env kill-switch — resolved server-side and delivered on
 * `ctx.runtimeDecisionRoutingEnabled`), codex is driven via `codex app-server`
 * (a long-lived JSON-RPC child) instead of the one-shot `codex exec`. The
 * app-server exposes a blocking approval callback
 * (`item/commandExecution/requestApproval` / `item/fileChange/requestApproval`)
 * that we bridge to the human-decision broker via `handleApprovalRequest`.
 *
 * This module owns ONLY the bridged turn: spawn the client, wire the
 * forwarding-ref handlers the driver installs, drive one turn, close the client,
 * and return a NEUTRAL INTERMEDIATE. `execute.ts` assembles the final
 * `AdapterExecutionResult` from that intermediate via the SAME builder the exec
 * path uses, so the two spawn modes cannot drift on result shape.
 *
 * The exec path stays in `execute.ts`, untouched and byte-identical.
 *
 * Testability: the real dependencies (`spawnAppServerClient`,
 * `driveCodexAppServer`, `createAppServerResultAccumulator`) are injected via a
 * `deps` param defaulting to the real implementations, so the routing unit test
 * stubs them with no real codex process.
 */
import type {
  AdapterRuntimeDecisionBroker,
} from "@armyofagents/adapter-utils";
import { RUNTIME_HOOK_BLOCK_TIMEOUT_SEC } from "@armyofagents/adapter-utils";
import {
  spawnAppServerClient as realSpawnAppServerClient,
  type SpawnAppServerClientOptions,
  type SpawnedAppServerClient,
} from "./app-server/jsonrpc-client.js";
import {
  driveCodexAppServer as realDriveCodexAppServer,
  type DriveCodexAppServerInput,
  type DriverResult,
} from "./app-server/driver.js";
import { createAppServerResultAccumulator as realCreateAccumulator } from "./app-server/parse-events.js";
import { handleApprovalRequest } from "./app-server/approval-bridge.js";
import { stripCodexRolloutNoise } from "./parse-shared.js";
import { appendWithCap } from "@armyofagents/adapter-utils/server-utils";
import {
  clearCodexModelConfigToml,
  writeCodexModelConfigToml,
} from "./codex-config-toml.js";

/** Cap total forwarded bridged-stderr so a chatty session can't grow logs without bound. */
const APP_SERVER_STDERR_FORWARD_CAP = 32 * 1024;

/** Injectable dependency set (defaults to the real app-server implementations). */
export interface RunAppServerTurnDeps {
  spawnAppServerClient: (opts: SpawnAppServerClientOptions) => SpawnedAppServerClient;
  driveCodexAppServer: (input: DriveCodexAppServerInput) => Promise<DriverResult>;
  createAppServerResultAccumulator: () => DriveCodexAppServerInput["accumulator"];
}

export const defaultRunAppServerTurnDeps: RunAppServerTurnDeps = {
  spawnAppServerClient: realSpawnAppServerClient,
  driveCodexAppServer: realDriveCodexAppServer,
  createAppServerResultAccumulator: realCreateAccumulator,
};

export interface RunAppServerTurnInput {
  runId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  timeoutSec: number;
  graceSec: number;
  /** Resumable stored session (cwd-guarded inside the driver). */
  session?: { sessionId: string; cwd?: string };
  /** Human-decision broker (from ctx). Absent → approvals fail closed. */
  broker?: AdapterRuntimeDecisionBroker;
  /** Forwarded to spawnTrackedChild so the controller can persist PID/PGID. */
  onSpawn?: (pid: number | null, pgid: number | null, startedAt: Date) => void;
  /** Non-fatal warning / audit sink. */
  onWarn?: (message: string) => void;
  /** Injectable deps for tests; real app-server implementations by default. */
  deps?: RunAppServerTurnDeps;
  /**
   * Resolved codex-compatible chat model for the supervised path. When set (and
   * managedCodexHome is provided), written into <managedCodexHome>/config.toml
   * before spawn so a ChatGPT-auth account does not fall back to gpt-5.3-codex
   * (which 400s → empty turn). Left undefined in api-key mode, where the
   * compiled-in default is valid. (BUG-6 fix 1.)
   */
  model?: string;
  /** The adapter-owned CODEX_HOME the app-server child reads config.toml from. */
  managedCodexHome?: string;
  /**
   * Env keys to strip from the inherited parent env on spawn (unless the overlay
   * set them). Defaults to `["OPENAI_API_KEY"]` (ambient billing safety). FU-23:
   * the exec path passes the connector-aware AoA ambient-secret list here on
   * connector-hosting runs so a stdio connector child cannot inherit AoA secrets.
   */
  unsetEnvKeys?: string[];
}

/**
 * Drive ONE supervised codex turn over `codex app-server` and return the
 * driver's `DriverResult` (a neutral intermediate + session lifecycle fields).
 * `execute.ts` turns this into an `AdapterExecutionResult`.
 */
export async function runAppServerTurn(
  input: RunAppServerTurnInput,
): Promise<DriverResult> {
  const {
    runId,
    command,
    cwd,
    env,
    prompt,
    timeoutSec,
    graceSec,
    session,
    broker,
    onSpawn,
    onWarn,
    model,
    managedCodexHome,
    unsetEnvKeys = ["OPENAI_API_KEY"],
    deps = defaultRunAppServerTurnDeps,
  } = input;

  const accumulator = deps.createAppServerResultAccumulator();

  // ── Forwarding-ref wiring (client ↔ driver) ────────────────────────────────
  // The driver installs its handlers via `registerNotificationHandler` /
  // `registerServerRequestHandler` (called synchronously before the handshake).
  // The spawn callbacks must forward EVERY frame to whatever the driver
  // installed — but the client is spawned BEFORE the driver runs, so the spawn
  // callbacks close over mutable refs that the driver later fills.
  let notificationHandler:
    | ((method: string, params: unknown) => void)
    | null = null;
  let serverRequestHandler:
    | ((id: number | string, method: string, params: unknown) => void | Promise<void>)
    | null = null;

  const registerNotificationHandler: DriveCodexAppServerInput["registerNotificationHandler"] = (
    handler,
  ) => {
    notificationHandler = handler;
  };
  const registerServerRequestHandler: DriveCodexAppServerInput["registerServerRequestHandler"] = (
    handler,
  ) => {
    serverRequestHandler = handler;
  };

  // Bridged-stderr forwarding: strip Codex rollout noise (parity with the exec
  // path) and forward via onWarn, capping total length so a chatty supervised
  // session can't grow logs without bound (mirrors the exec path's appendWithCap
  // spirit). The DRAIN itself lives in spawnAppServerClient (I1) — this is only
  // the best-effort forward on top of it.
  let forwardedStderr = "";
  const forwardStderr = onWarn
    ? (chunk: string): void => {
        const cleaned = stripCodexRolloutNoise(chunk);
        if (!cleaned.trim()) return;
        const before = forwardedStderr;
        forwardedStderr = appendWithCap(
          forwardedStderr,
          cleaned,
          APP_SERVER_STDERR_FORWARD_CAP,
        );
        // Only emit while under the cap — once saturated we stop forwarding new
        // lines (the pipe is still drained by the transport listener regardless).
        if (forwardedStderr.length > before.length) {
          onWarn(`[aoa] codex app-server stderr: ${cleaned.trim()}`);
        }
      }
    : undefined;

  // BUG-6 fix 1: deliver the resolved chat model to the supervised path via the
  // managed config.toml (codex app-server has no per-turn --model flag). API-key
  // mode leaves model undefined, so clear any stale top-level model previously
  // written for subscription auth while preserving the MCP bridge block.
  if (managedCodexHome) {
    if (model) {
      await writeCodexModelConfigToml(managedCodexHome, model);
    } else {
      await clearCodexModelConfigToml(managedCodexHome);
    }
  }

  const spawned = deps.spawnAppServerClient({
    runId,
    command,
    cwd,
    env,
    graceSec,
    onStderr: forwardStderr,
    // Preserve the env-strip on the bridged path too — the ambient server
    // OPENAI_API_KEY must never reach a supervised codex run and flip billing.
    // (spawnAppServerClient also defaults this; we pass it explicitly so the
    // guard survives even if that default is ever changed.) FU-23: the caller
    // broadens this to all AoA ambient secrets on connector-hosting runs.
    unsetEnvKeys,
    onSpawn,
    onNotification: (method, params) => {
      notificationHandler?.(method, params);
    },
    onServerRequest: (id, method, params) => serverRequestHandler?.(id, method, params),
    onError: (err) => {
      onWarn?.(
        `[aoa] codex app-server transport error: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  });

  try {
    const result = await deps.driveCodexAppServer({
      runId,
      cwd,
      input: [{ type: "text", text: prompt }],
      // The bridge always drives codex in the fully-supervised policy so EVERY
      // command + file change surfaces a `requestApproval` we route to the human.
      approvalPolicy: "untrusted",
      timeoutSec,
      client: spawned.client,
      accumulator,
      onServerApproval: (method, params) =>
        handleApprovalRequest(method, params, {
          broker,
          bridged: true,
          timeoutMs: RUNTIME_HOOK_BLOCK_TIMEOUT_SEC * 1000,
          cwd,
          onLog: onWarn ? (msg) => onWarn(msg) : undefined,
        }),
      registerServerRequestHandler,
      registerNotificationHandler,
      terminate: spawned.terminate,
      session,
      onWarn,
    });
    return result;
  } finally {
    try {
      spawned.client.close();
    } catch {
      // close must never throw into the caller.
    }
  }
}
