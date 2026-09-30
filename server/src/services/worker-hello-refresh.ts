// server/src/services/worker-hello-refresh.ts
//
// WRK-011 (Sprint 2.75) — the server half of the hello-refresh surface: the LOCAL request
// schema, the LOCAL operation descriptor, the canonical digest, and (below) the one
// transaction that moves `profile_snapshot`, `profile_hash` and a fresh session together.
//
// It CONSUMES the FROZEN `workerHelloV1Schema` as a field of a server-local envelope — the
// same pattern WRK-008 slice 1's `selfModelReadBody` and WRK-010 slice 1's
// `sessionRenewRequestSchema` used. This is NOT an eleventh frozen worker-control operation
// (E4-D02 keeps the ten closed); the descriptor below is LOCAL, exactly like
// `SESSION_RENEW_DESCRIPTOR` (worker-session-renewal.ts:45) and the self-model read's.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  workerHelloV1Schema,
  type AuthAudience,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";
import type { Db } from "@armyofagents/db";
import { runInTenant } from "../db/tenant-context.js";
import {
  SESSION_MAX_MS,
  createWorkerSessionToken,
  type VerifiedTargetPrincipal,
} from "../middleware/worker-session-auth.js";
import {
  admitHelloRefresh,
  type HelloRefusalReason,
} from "./worker-hello-refresh-admission.js";

/**
 * The LOCAL descriptor for this operation. Shaped like `OperationDescriptorV1` so the route
 * reads the way the frozen ten do, but it lives here — the frozen package is not extended
 * (E4-D02). Mirrors the self-model read's 64 KiB / 15 s (client.ts:77-80): the request
 * carries one hello, larger is not one of ours. `audience` is `device_session`: the
 * credential this route both consumes and issues.
 *
 * `maxRequestBytes` MUST stay strictly below the global 20mb body limit (app.ts:302) or
 * express refuses first and the handler's size guard is dead code.
 */
export const SELF_HELLO_DESCRIPTOR = {
  operation: "self_hello_refresh",
  audience: "device_session" as AuthAudience,
  idempotent: false,
  maxRequestBytes: 64 * 1024,
  timeoutMs: 15_000,
} as const;

/**
 * The request body. `correlationId` is a UUID because `workerProtocolErrorV1` only echoes a
 * UUID (worker-protocol-http.ts:20-27); a looser type would silently drop it from refusals.
 * The device proof signs it, so it is not a second, unsigned identity source. `hello`
 * composes the FROZEN `workerHelloV1Schema` verbatim.
 */
export const selfHelloRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    correlationId: z.string().uuid(),
    // Cast to a flat `ZodType<WorkerHelloV1>` so composing the branded frozen schema does not
    // overflow TS instantiation depth (TS2589) in the server package. Runtime validation is
    // unchanged — the frozen schema still runs — and `.strict()` still rejects extra top-level
    // keys; only the inferred TYPE is flattened.
    hello: workerHelloV1Schema as unknown as z.ZodType<WorkerHelloV1>,
  })
  .strict();

export type SelfHelloRequest = z.infer<typeof selfHelloRequestSchema>;

/**
 * The canonical profile digest — defined HERE and ONLY here. It hashes the ZOD-PARSED hello,
 * byte-for-byte the value `worker-enrollment.ts:409` hashes at enrolment
 * (`sha256(JSON.stringify(request.hello))`), so a snapshot written by this route re-derives
 * to the same `profile_hash` at `job-placement.ts:543`. Hashing a raw (unparsed) body would
 * produce a value that never matches again — §8 M11 is that mutant.
 */
export function digestHello(hello: WorkerHelloV1): string {
  return createHash("sha256").update(JSON.stringify(hello)).digest("hex");
}

// --- The transaction: the atomic triple ---------------------------------------

/** The identity half of the session to mint — never iat/exp (the service stamps those). */
export interface HelloRefreshMintIdentity {
  readonly aud: "device_session";
  readonly sub: string;
  readonly organizationId: string;
  readonly targetId: string;
  readonly generation: number;
  readonly scope: "organization" | "owner";
  readonly deviceThumbprint: string;
  readonly profileHash: string;
}

export interface MintedRefreshSession {
  readonly session: string;
  readonly expiresAt: string;
  readonly iat: number;
  readonly exp: number;
}

/** Injectable for the throwing-signer test (§7 Step 5). Default binds the signing key. */
export type HelloRefreshMint = (identity: HelloRefreshMintIdentity, now: Date) => MintedRefreshSession;

export function mintRefreshSession(
  sessionSigningKey: string,
  identity: HelloRefreshMintIdentity,
  now: Date,
): MintedRefreshSession {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = Math.floor((now.getTime() + SESSION_MAX_MS) / 1000);
  const session = createWorkerSessionToken(sessionSigningKey, { ...identity, iat, exp });
  return { session, expiresAt: new Date(exp * 1000).toISOString(), iat, exp };
}

/**
 * The outcome the route renders. `refused` → 401 `unauthorized` (the `logReason` is the
 * operator-log discriminant only, never on the wire — §5.3); `unavailable` → 503, reserved
 * for a mint/DB defect so a healthy worker is never told it is unauthorized for OUR bug
 * (the same discipline the renewal service applies at worker-session-renewal.ts:185-199).
 */
export type HelloRefreshOutcome =
  | { readonly outcome: "refreshed"; readonly session: string; readonly profileHash: string; readonly expiresAt: string }
  | { readonly outcome: "unchanged" }
  | { readonly outcome: "refused"; readonly logReason: HelloRefusalReason | "platform_physical_unsupported" | "refresh_conflict" }
  | { readonly outcome: "unavailable" };

export function createWorkerHelloRefreshService(deps: {
  appDb: Db;
  sessionSigningKey: string;
  now?: () => Date;
  mint?: HelloRefreshMint;
}) {
  const now = deps.now ?? (() => new Date());
  const mint: HelloRefreshMint = deps.mint ?? ((identity, at) => mintRefreshSession(deps.sessionSigningKey, identity, at));

  return {
    async refresh(input: {
      principal: VerifiedTargetPrincipal;
      hello: WorkerHelloV1;
      ratified: { readonly capabilityCeiling: readonly string[]; readonly policyHash: string } | null;
    }): Promise<HelloRefreshOutcome> {
      const { principal } = input;

      const decision = admitHelloRefresh({
        principal: { workerId: principal.workerId, targetId: principal.targetId, targetGeneration: principal.targetGeneration },
        hello: input.hello,
        ratified: input.ratified,
        currentProfileHash: principal.profileHash,
        digestOf: digestHello,
      });
      if (!decision.admit) return { outcome: "refused", logReason: decision.reason };

      // Platform PHYSICAL (organizationId === null) is a §10 non-goal, refused UNIFORMLY —
      // BEFORE the no-op short-circuit, so a null-org principal presenting its current hello
      // gets a refusal rather than a 204 (codex review, guard-ordering fix). This narrow is
      // also TYPE-ENFORCED: `runInTenant` below requires a non-null organizationId, so deleting
      // it is a compile error (the typecheck is its artifact). A shared-platform TENANT worker
      // has a non-null org and IS covered.
      const organizationId = principal.organizationId;
      if (organizationId === null) return { outcome: "refused", logReason: "platform_physical_unsupported" };

      if (!decision.changed) return { outcome: "unchanged" };
      const scope: "organization" | "owner" = principal.scope === "owner" ? "owner" : "organization";

      const at = now();
      const identity: HelloRefreshMintIdentity = {
        aud: "device_session",
        sub: principal.workerId,
        organizationId,
        targetId: principal.targetId,
        generation: principal.targetGeneration,
        scope,
        deviceThumbprint: principal.deviceThumbprint,
        profileHash: decision.profileHash,
      };

      try {
        return await runInTenant(deps.appDb, organizationId, async (repos): Promise<HelloRefreshOutcome> => {
          // ★ THE ATOMIC TRIPLE. profile_snapshot + profile_hash move together (one UPDATE),
          // and the mint happens INSIDE this transaction and AFTER the update — a mint throw
          // rolls the UPDATE back, so a committed refresh always has a live session (§3.2).
          const ok = await repos.workerEnrollment.refreshWorkerProfile({
            workerId: principal.workerId,
            executionTargetId: principal.targetId,
            expectedProfileHash: principal.profileHash,
            profileSnapshot: input.hello as unknown as Record<string, unknown>,
            profileHash: decision.profileHash,
            now: at,
          });
          // Compare-and-set lost: another refresh moved the row between auth and this write.
          if (!ok) return { outcome: "refused", logReason: "refresh_conflict" };
          const minted = mint(identity, at); // throws ⇒ rollback + propagate to the catch
          return { outcome: "refreshed", session: minted.session, profileHash: decision.profileHash, expiresAt: minted.expiresAt };
        });
      } catch {
        // A mint/DB throw rolled the UPDATE back. Server defect, not a fact about the caller.
        return { outcome: "unavailable" };
      }
    },
  };
}
