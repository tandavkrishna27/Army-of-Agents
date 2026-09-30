// -----------------------------------------------------------------------------
// adapter-manager server (DEP-012 Slice 1 · Units A + B1 + B2).
//
// The out-of-process host of the per-op `SandboxProvider`. `createProviderServer({ provider })`
// mounts an HTTP listener; per request it routes a per-op path, deserializes `{args, ctx}`,
// calls the provider (directly or THROUGH the ownership gate), and serializes `{ok: result}`
// or `{err: <coded>}`. It is PROVIDER-AGNOSTIC — the concrete `E2bSandboxProvider` + key-less
// `MockE2bTransport` are injected by the caller (the component test), so this runtime imports
// no provider and no `e2b` SDK.
//
// ★ EXHAUSTIVE FAIL-CLOSED ROUTING (B2). When GATED (a control-plane public key is pinned),
// EVERY gate-required op — `execute` + the 4 teardown ops + `inspect`/`list` — routes THROUGH
// the ownership gate; there is NO raw `handler` fallback reachable for any of them. The 5 ops
// B2 adds (cancel/kill/destroy/reconcile_cleanup/inspect/list minus execute) have NO Map
// handler at all, so on an UNGATED (keyless) server they 404 — a raw `provider.inspect`/`list`
// (which would leak env/secrets) can NEVER return over the wire. Only `execute` keeps its
// keyless-ungated handler (Unit A back-compat).
//
// ★ NO mTLS / peer-allowlist / net-seg yet. The real topology (`control-net`, mutual-auth,
// peer-allowlist, `internal:true`) is Slice-5 deploy hardening — not modelled here.
// -----------------------------------------------------------------------------

import { createServer, type Server, type ServerResponse } from "node:http";
import type { KeyObject } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CreateSandboxSpec,
  ExecuteInput,
  ListInput,
  ProviderOpContext,
  SandboxProvider,
  StagedFileRequest,
} from "@armyofagents/worker-daemon";
import { WireProtocolError, decodeOpRequest, encodeErrResponse, encodeOkResponse, isModelledWireError } from "@armyofagents/provider-wire/codec";
import type { OwnedLabelsCapability } from "@armyofagents/provider-wire";

import { gateList, gateOwnedOp, redactProjection, type OwnedOpGateDeps } from "./owned-op-gate.js";
import { gateCreate, type CreateGateDeps } from "./create-gate.js";
import { IdempotencyLedger } from "./idempotency-ledger.js";
import { KeyedMutex } from "./keyed-mutex.js";
import { createReaperMetrics, renderReaperMetrics, type ReaperMetricsCounter } from "./reaper-metrics.js";

export interface CreateProviderServerOptions {
  readonly provider: SandboxProvider;
  /**
   * The pinned control-plane PUBLIC key (DEP-012 Units B1/B2). When PRESENT, the server
   * is GATED: every gate-required op (execute + the 4 teardown ops + inspect/list) must
   * carry a valid owned-labels capability whose labels + generation match the target,
   * else the uniform ResourceNotAvailableError. When ABSENT the server is UNGATED — Unit
   * A's component-test-only / NOT deploy-safe posture (S1.4): only create + execute have
   * handlers, and the 5 B2 ops 404 (a raw inspect/list can never leak). Slice 5's deploy
   * ordering assertion enforces that a real deployment configures the key.
   */
  readonly controlPlanePublicKey?: KeyObject;
  /** Injectable ms-epoch clock for the capability expiry check (default: Date.now). */
  readonly now?: () => number;
  /**
   * The durable idempotency ledger's runtime directory (DEP-012 Slice 3 · β1). Used
   * ONLY on a GATED server — every gated `create` records `(identity, idempotencyKey)`
   * here. A real deployment (β2) points it at a configured, out-of-tree volume (a
   * shared volume across replicas is deploy-owed). When omitted on a gated server it
   * defaults to a fresh OS temp dir (component-test posture — per-instance, ephemeral,
   * out-of-tree); an ungated server never constructs a ledger at all.
   */
  readonly idempotencyLedgerDir?: string;
  /**
   * DEP-011 reaper Slice C — the ONE shared AM-local metric counter, created by the bin
   * BEFORE `startServer` and passed into BOTH `/metrics` (here) AND the reaper loop
   * (B2C-F9). When omitted, `/metrics` renders zeros (an ungated server still calls
   * `createProviderServer`, and a gated server with the reaper flag off has no loop).
   */
  readonly reaperMetrics?: ReaperMetricsCounter;
}

type OpHandler = (args: unknown, ctx: ProviderOpContext) => Promise<unknown>;

const OP_ROUTE = /^\/op\/([a-z_]+)$/;

// The gate-required ops. On a GATED server every one routes through a gate; none is
// reached by a raw handler when gated. `create` + `execute` are BOTH gate-required AND
// keyless-handler-backed (so an UNGATED server keeps Unit A's back-compat create +
// execute); the other five are GATED-ONLY. `create` uses the DISTINCT create-gate
// (verify -> spec-label match -> the durable ledger), NOT `gateOwnedOp`.
//
// ★ `create` joins the set AND the `routeGated` switch in the SAME change (β1.2 R2): the
// set and the switch move together, else a gated `create` falls to the `default` reject.
const GATE_REQUIRED_OPS: ReadonlySet<string> = new Set([
  "create",
  "execute",
  "cancel",
  "kill",
  "destroy",
  "reconcile_cleanup",
  "inspect",
  "list",
  // E7-F011 — staging writes into a live OWNED sandbox, so it is a single-sandbox owned op:
  // GATED-ONLY (no keyless raw handler below), routed through `gateOwnedOp`. An ungated
  // server 404s it, matching the B2 teardown ops, because it carries a bearer grant.
  "stage_files",
]);

export function createProviderServer(options: CreateProviderServerOptions): Server {
  const { provider } = options;
  const controlPlanePublicKey = options.controlPlanePublicKey;
  const now = options.now ?? (() => Date.now());
  // GATED iff a control-plane public key is pinned. Ungated is Unit A's not-deploy-safe
  // posture — see CreateProviderServerOptions.controlPlanePublicKey.
  const gated = controlPlanePublicKey !== undefined;
  // The shared reaper metric counter (or a fresh zeroed one so `/metrics` renders zeros
  // when no reaper is wired). Slice C's loop mutates the SAME ref on the single event loop.
  const reaperMetrics = options.reaperMetrics ?? createReaperMetrics();

  // A Map (not an object literal) so an inherited prototype key like
  // `constructor`/`__proto__` can NEVER resolve to a handler and return a spurious ok.
  // ONLY create (gate-free) + execute (Unit A keyless back-compat) have raw handlers; the
  // five B2 ops are deliberately ABSENT so an ungated server 404s them (never raw).
  const handlers = new Map<string, OpHandler>([
    ["create", (args, ctx) => provider.create(args as CreateSandboxSpec, ctx)],
    ["execute", (args, ctx) => provider.execute(args as ExecuteInput, ctx)],
  ]);

  // The durable ledger + the per-(identity,key) create mutex exist ONLY on a gated
  // server (the create-gate's idempotency authority). The ledger dir is configured, or
  // defaults to a fresh OS temp dir (out-of-tree — never the repo, β1.7).
  const createGateDeps: CreateGateDeps | null = gated
    ? {
        provider,
        controlPlanePublicKey: controlPlanePublicKey!,
        now,
        ledger: new IdempotencyLedger({
          dir: options.idempotencyLedgerDir ?? mkdtempSync(join(tmpdir(), "aoa-am-ledger-")),
        }),
        createLock: new KeyedMutex(),
      }
    : null;

  const gateDeps: OwnedOpGateDeps | null = gated
    ? { provider, controlPlanePublicKey: controlPlanePublicKey!, now, sandboxLock: new KeyedMutex() }
    : null;

  // Route a gate-required op THROUGH the ownership gate (only reachable when gated).
  function routeGated(
    op: string,
    args: unknown,
    ctx: ProviderOpContext,
    capability: OwnedLabelsCapability | undefined,
  ): Promise<unknown> {
    const deps = gateDeps!;
    switch (op) {
      case "create": {
        // The DISTINCT create-gate (no inspect): verify -> spec-label match -> the
        // durable ledger -> provider.create with a stripped key. NOT gateOwnedOp.
        return gateCreate(createGateDeps!, args as CreateSandboxSpec, ctx, capability);
      }
      case "execute": {
        const input = args as ExecuteInput;
        return gateOwnedOp(deps, input.sandboxId, ctx, capability, () => provider.execute(input, ctx));
      }
      case "cancel": {
        const sandboxId = args as string;
        return gateOwnedOp(deps, sandboxId, ctx, capability, () => provider.cancel(sandboxId, ctx));
      }
      case "kill": {
        const sandboxId = args as string;
        return gateOwnedOp(deps, sandboxId, ctx, capability, () => provider.kill(sandboxId, ctx));
      }
      case "destroy": {
        const sandboxId = args as string;
        return gateOwnedOp(deps, sandboxId, ctx, capability, () => provider.destroy(sandboxId, ctx));
      }
      case "reconcile_cleanup": {
        const sandboxId = args as string;
        return gateOwnedOp(deps, sandboxId, ctx, capability, () => provider.reconcileCleanup(sandboxId, ctx));
      }
      case "inspect": {
        const sandboxId = args as string;
        // The gate fetches the detail for the owned-check; the route RETURNS redact(that
        // ALREADY-FETCHED detail) — NEVER provider.inspect raw, NEVER the full detail.
        return gateOwnedOp(deps, sandboxId, ctx, capability, (detail) => Promise.resolve(redactProjection(detail)));
      }
      case "list":
        return gateList(deps, args as ListInput, ctx, capability);
      case "stage_files": {
        // E7-F011 — a single-sandbox owned mutation (writes files into the live sandbox).
        // Same gate as execute/cancel: verify capability -> AM-local inspect -> field-wise
        // owned-check -> dispatch. The far provider redeems each file's download grant,
        // verifies sha256/maxBytes, and writes; only the result paths cross back.
        const { sandboxId, files } = args as { sandboxId: string; files: readonly StagedFileRequest[] };
        return gateOwnedOp(deps, sandboxId, ctx, capability, () => provider.stageFiles(sandboxId, files, ctx));
      }
      default:
        // GATE_REQUIRED_OPS is the exhaustive set; this is unreachable.
        return Promise.reject(new WireProtocolError(`operation not available in this slice: ${op}`));
    }
  }

  return createServer((req, res) => {
    // A socket/stream error must never become an uncaught exception (process crash).
    res.on("error", () => {});

    if (req.method === "GET" && req.url === "/healthz") {
      sendJson(res, 200, JSON.stringify({ status: "ok" }));
      return;
    }

    // DEP-011 reaper Slice C — the metric surface (Prometheus text). Renders zeros when no
    // reaper is wired (Slice 5 owns the scrape target). Beside /healthz, same guarded write.
    if (req.method === "GET" && req.url === "/metrics") {
      sendText(res, 200, renderReaperMetrics(reaperMetrics));
      return;
    }

    const match = req.method === "POST" && req.url ? OP_ROUTE.exec(req.url) : null;
    if (!match) {
      sendJson(res, 404, encodeErrResponse(new WireProtocolError(`no route for ${req.method} ${req.url ?? ""}`)));
      return;
    }

    const op = match[1];

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("error", () => {
      sendJson(res, 200, encodeErrResponse(new WireProtocolError("request stream error")));
    });
    req.on("end", () => {
      void (async () => {
        try {
          // GATED + a gate-required op -> the ownership gate (verify capability -> AM-local
          // inspect -> field-wise owned-check -> dispatch). A refusal throws the uniform
          // ResourceNotAvailableError, caught below and coded back symmetrically.
          if (gated && GATE_REQUIRED_OPS.has(op)) {
            const { args, ctx, capability } = decodeOpRequest(body);
            const result = await routeGated(op, args, ctx, capability);
            sendJson(res, 200, encodeOkResponse(result));
            return;
          }
          // Otherwise a raw handler (create always; execute when ungated). An op with no
          // handler — the five B2 ops on an UNGATED server, or a truly unknown op — is a
          // WIRE error (404), never a raw provider.inspect/list and never a silent success.
          const handler = handlers.get(op);
          if (!handler) {
            sendJson(res, 404, encodeErrResponse(new WireProtocolError(`operation not available in this slice: ${op}`)));
            return;
          }
          const { args, ctx } = decodeOpRequest(body);
          const result = await handler(args, ctx);
          sendJson(res, 200, encodeOkResponse(result));
        } catch (err) {
          // The provider's domain errors (SandboxNotFoundError / SandboxEgressDeniedError /
          // UnsupportedProviderOperation / the uniform ResourceNotAvailableError) + a
          // malformed request cross back as coded err envelopes; the driver reconstructs the
          // authoritative class. sendJson is guarded, so this catch can never re-throw.
          //
          // ★ [Cred-2] (DEP-012 Slice 4+5) — the leak fence. A raw e2b SDK throw reaching
          // here would be forwarded VERBATIM by serializeError, whose TWO unmodelled arms
          // (`err instanceof Error → err.message` AND the non-Error `String(err)`) can carry
          // a leaked provider-auth value (nothing wraps the SDK call that receives envVars).
          // So AM-LOCALLY (not the shared codec — no other consumer perturbed), map ANY error
          // that is not a MODELLED wire class to a FIXED generic WireProtocolError BEFORE
          // encoding — dropping both raw-text arms at once. Modelled classes pass as-is (their
          // messages are fixed by the class vocabulary, never tenant data).
          const safe = isModelledWireError(err)
            ? err
            : new WireProtocolError("adapter-manager provider operation failed");
          sendJson(res, 200, encodeErrResponse(safe));
        }
      })();
    });
  });
}

/** Write a JSON body exactly once. Idempotent: a second call (e.g. after a mid-flight
 * stream error already ended the response) is a no-op, so a double-write can never throw
 * `ERR_STREAM_HEADERS_SENT` out of the request handler and crash the process. */
function sendJson(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent || res.writableEnded) return;
  try {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  } catch {
    // The socket was destroyed between the guard and the write — swallow; there is no
    // response to send and nothing to recover.
  }
}

/** Write a text/plain body exactly once (the /metrics Prometheus surface). Same idempotent
 * guard as `sendJson` so a double-write can never crash the request handler. */
function sendText(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent || res.writableEnded) return;
  try {
    res.writeHead(status, { "content-type": "text/plain; version=0.0.4" });
    res.end(body);
  } catch {
    // Socket destroyed between the guard and the write — nothing to recover.
  }
}
