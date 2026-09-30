// server/src/services/egress-proxy.ts
//
// DAT-005 D2 — the FENCE-AWARE egress proxy (server-side, inert-until-wired).
//
// Per governed egress request `{fence identity, handleId, requestedUrl}` it:
//   1. Loads the job's network policy (injected seam) — a missing/unrecordable
//      policy version DENIES (fail-closed, invariant #5).
//   2. `broker.resolve()` (DAT-004) → FULL per-request fence reauth in one tenant
//      tx, persisting `applied_policy_version` in the SAME audit UPDATE (D3). A
//      stale/terminal/revoked fence → denied with the frozen fence reason (or a
//      thrown `JobLeasingError` for an auth-layer fence failure, mirroring the
//      secret broker — the live request channel maps it).
//   3. `classifyEgressDestination` (D1) → default-deny allowlist + IP-range +
//      control-plane + DNS-rebind. Non-`allow` → denied with the exact frozen class.
//   4. Binds the requested URL to the handle's per-request `destination` (both must
//      resolve to the same allowlisted origin) — a handle bound to destination X can
//      never be used to reach host Y.
//   5. Materializes `material.value` into request HEADERS at DELIVERY (never a spec,
//      env, or log — generalizing the connector header-injection discipline) and
//      dispatches through an IP-PINNED socket (`buildPinnedRequestOptions`, closing
//      the DNS-rebind window between classify and connect).
//
// The value only ever exists server-side (the E4-D01 boundary forbids it in the
// worker-daemon). The LIVE request channel (how a sandbox reaches this proxy) is an
// INERT seam wired at E4-D12 — the proxy is exposed as an injectable/testable
// function, and the default dispatcher fails closed until then. A broker,
// materialization, or dispatch fault is a coarse, non-disclosing `malformed` deny —
// never a value leak, never a disclosing error.

import type { Db } from "@armyofagents/db";
import type { NetworkPolicyV1 } from "@armyofagents/worker-protocol";
import { lookup as dnsLookup } from "node:dns/promises";
import type { RequestOptions as HttpRequestOptions } from "node:http";
import {
  createSecretBrokerService,
  type SecretBrokerSet,
  type SecretResolveOutcome,
} from "./secret-broker.js";
import type { JobControlMetrics } from "./job-control-metrics.js";
import type { VerifiedWorkerOperation } from "./job-leasing.js";
import {
  classifyEgressDestination,
  resolveControlPlaneDenySet,
  type ControlPlaneDenySet,
  type NetworkDenialClass,
} from "./egress-policy.js";
import { buildPinnedRequestOptions, type ValidatedFetchTarget } from "./outbound-url-guard.js";

/** The egress request presented to the proxy. Mirrors the secret-broker request +
 * the destination the sandbox wants to reach. Not a frozen wire op. */
export interface EgressRequestV1 {
  workerId: string;
  jobId: string;
  attempt: number;
  leaseId: string;
  fenceToken: string;
  /** The opaque execution-secret handle id backing this governed egress. */
  handleId: string;
  /** The absolute https URL the sandbox wants to reach (must be allowlisted + bound). */
  requestedUrl: string;
}

/** A fence-denial reason surfaced by the broker reauth. */
type FenceDenyReason = "stale_fence" | "attempt_terminal" | "target_revoked";

export type EgressDenyReason = NetworkDenialClass | "malformed" | FenceDenyReason;

export type EgressOutcome =
  | { outcome: "dispatched"; status: number; appliedPolicyVersion: number; destination: string }
  | { outcome: "denied"; reason: EgressDenyReason };

/** The pinned request the proxy hands to the dispatcher — the socket connects to
 * `options.host` (the resolved IP), preserving the Host header + TLS SNI. The
 * materialized secret is already in `options.headers`. */
export interface EgressDispatchInput {
  readonly options: HttpRequestOptions & { servername?: string };
  readonly body: string | Buffer | undefined;
  readonly target: ValidatedFetchTarget;
}

export interface EgressDispatchResult {
  readonly status: number;
}

export type EgressDispatcher = (input: EgressDispatchInput) => Promise<EgressDispatchResult>;

/** The default dispatcher fails closed — the LIVE outbound socket is the E4-D12
 * inert seam. A wired deployment injects `executePinnedRequest`-backed dispatch. */
export const failClosedEgressDispatcher: EgressDispatcher = async () => {
  throw new Error("egress dispatch channel not wired (E4-D12)");
};

export interface FenceAwareEgressProxyDeps {
  readonly appDb: Db;
  /** The DAT-004 value-store brokers (default fail-closed). */
  readonly brokers?: SecretBrokerSet;
  /** Resolve the job's network policy for a fence (the inert policy-store seam).
   * A null/throw is a fail-closed `malformed` deny (no recordable version). */
  readonly resolveNetworkPolicy: (fence: {
    organizationId: string;
    workerId: string;
    jobId: string;
    attempt: number;
    leaseId: string;
    fenceToken: string;
  }) => Promise<NetworkPolicyV1 | null>;
  /** Resolve a hostname to its addresses (default: node dns lookup, all records). */
  readonly resolveAddresses?: (host: string) => Promise<string[]>;
  /** Deliver the pinned request (default: fail-closed inert seam). */
  readonly dispatch?: EgressDispatcher;
  /** The config-sourced control-plane deny set (default: env). */
  readonly controlPlane?: ControlPlaneDenySet;
  readonly maxHeartbeatAgeMs?: number;
  /** DEP-007 — count-only, id-free egress-deny telemetry. Emits ONLY the closed
   * deny-reason enum (never the requested URL, host, or handle). Defaults to no-op;
   * threaded into the embedded secret broker; best-effort, never alters the deny path. */
  readonly metrics?: JobControlMetrics;
}

const denied = (reason: EgressDenyReason): EgressOutcome => ({ outcome: "denied", reason });

async function defaultResolveAddresses(host: string): Promise<string[]> {
  try {
    const results = await dnsLookup(host, { all: true });
    return results.map((entry) => entry.address);
  } catch {
    return [];
  }
}

/** Parse an origin (scheme://host:port) from a URL string, lowercased host. */
function originOf(url: string): { host: string; port: number; href: URL } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = parsed.port === "" ? 443 : Number(parsed.port);
  if (!Number.isInteger(port)) return null;
  return { host, port, href: parsed };
}

export function createFenceAwareEgressProxy(deps: FenceAwareEgressProxyDeps) {
  // Optional-chained (no NOOP VALUE import) so this inert-seam module carries no
  // runtime dependency on job-control-metrics on any load path (dormancy gate).
  const metrics = deps.metrics;
  const broker = createSecretBrokerService({
    appDb: deps.appDb,
    brokers: deps.brokers,
    maxHeartbeatAgeMs: deps.maxHeartbeatAgeMs,
    metrics,
  });
  const resolveAddresses = deps.resolveAddresses ?? defaultResolveAddresses;
  const dispatch = deps.dispatch ?? failClosedEgressDispatcher;
  const controlPlane = deps.controlPlane ?? resolveControlPlaneDenySet();

  return {
    async egress(input: { auth: VerifiedWorkerOperation; request: EgressRequestV1 }): Promise<EgressOutcome> {
      const { auth, request } = input;
      // DEP-007 — count-only egress-deny telemetry: the closed reason enum only, never
      // the requested URL/host/handle. Best-effort so it never alters the deny path.
      const deny = (reason: EgressDenyReason): EgressOutcome => {
        try {
          metrics?.egressDenied({ reason, count: 1 });
        } catch {
          /* best-effort telemetry */
        }
        return denied(reason);
      };

      // 1. Load the network policy FIRST — a missing/unrecordable version fails
      //    closed (invariant #5). The version is a job-level fact, so it is known
      //    before the reauth and threaded into the audit write.
      let policy: NetworkPolicyV1 | null;
      try {
        policy = await deps.resolveNetworkPolicy({
          organizationId: auth.organizationId,
          workerId: request.workerId,
          jobId: request.jobId,
          attempt: request.attempt,
          leaseId: request.leaseId,
          fenceToken: request.fenceToken,
        });
      } catch {
        return deny("malformed");
      }
      if (!policy) return deny("malformed");

      // 2. Per-request fence reauth via the DAT-004 broker, persisting the applied
      //    policy version in the SAME audit UPDATE (D3). Auth-layer fence failures
      //    throw JobLeasingError (mirroring the secret broker; the live channel maps
      //    it). Mutator-layer fence failures come back as a denied outcome.
      let resolved: SecretResolveOutcome;
      try {
        resolved = await broker.resolve({
          auth,
          request: {
            workerId: request.workerId,
            jobId: request.jobId,
            attempt: request.attempt,
            leaseId: request.leaseId,
            fenceToken: request.fenceToken,
            handleId: request.handleId,
            appliedPolicyVersion: policy.version,
          },
        });
      } catch {
        // A broker/tx fault (incl. an unrecordable version) is fail-closed malformed.
        return deny("malformed");
      }

      if (resolved.outcome === "denied") return deny(resolved.reason);
      // A non-network (device-local) handle can never authorize egress.
      if (resolved.outcome !== "resolved") return deny("malformed");
      const material = resolved.material;
      // Only a network-use seam with a bound destination may egress (defense in depth
      // over authorizeSecretResolve, which already enforces this).
      if (resolved.seam === "sandbox_local_only" || !material.destination) return deny("malformed");

      // 4. Bind the requested URL to the handle's per-request destination: both must
      //    parse to the SAME allowlisted origin. A handle bound to destination X can
      //    never reach host Y (non-disclosing not_allowlisted on a mismatch).
      const dest = originOf(material.destination);
      const req = originOf(request.requestedUrl);
      if (!dest) return deny("malformed");
      if (!req || req.host !== dest.host || req.port !== dest.port) return deny("not_allowlisted");
      // The bound destination itself must be a member of the policy allowlist.
      const destAllowed = policy.allow.some(
        (rule) => rule.scheme === "https" && rule.host === dest.host && rule.port === dest.port,
      );
      if (!destAllowed) return deny("not_allowlisted");

      // 3. Resolve + classify (default-deny allowlist + IP-range + control-plane +
      //    DNS-rebind). A non-allow verdict denies with the exact frozen class.
      const resolvedAddrs = await resolveAddresses(req.host);
      const verdict = classifyEgressDestination(request.requestedUrl, resolvedAddrs, policy, controlPlane);
      if (verdict !== "allow") return deny(verdict);

      // 5. Materialize the value into request HEADERS at delivery, pin the socket to
      //    a resolved (already-cleared) address, and dispatch. A dispatch fault is a
      //    coarse malformed deny (never a value leak).
      const pinnedAddress = resolvedAddrs[0]!; // classify=allow ⇒ every resolved addr is safe
      const target: ValidatedFetchTarget = {
        parsedUrl: req.href,
        resolvedAddress: pinnedAddress,
        hostHeader: req.href.host,
        tlsServername: req.host,
        useTls: true,
      };
      const { options, body } = buildPinnedRequestOptions(target, {
        method: "GET",
        headers: { Authorization: `Bearer ${material.value}` },
      });
      try {
        const result = await dispatch({ options, body, target });
        return {
          outcome: "dispatched",
          status: result.status,
          appliedPolicyVersion: policy.version,
          destination: `https://${dest.host}:${dest.port}`,
        };
      } catch {
        return deny("malformed");
      }
    },
  };
}
