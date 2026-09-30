/**
 * @fileoverview D7 stdio governance gate — the AUTHORIZATION check for whether a
 * connector may cause a command to execute on the AoA host.
 *
 * Lives in services/ (not routes/) because it has two callers with nothing else
 * in common: the founder-facing BYO route and the catalog install route. A route
 * module is the wrong place to source an authorization primitive from.
 */

import { badRequest } from "../errors.js";

/**
 * A `stdio` connector's `command` executes on the AoA HOST when the loader serves
 * it — in a multi-tenant/`authenticated` deployment that is remote code
 * execution. So stdio is admissible ONLY when the host is the founder's own
 * machine (`local_trusted`) or the entry is a catalog install whose trust tier is
 * `verified`. `http` is always fine — it makes a network request, never a local
 * exec.
 *
 * THIS IS AN AUTHORIZATION GATE. It answers "is this principal permitted to make
 * this host execute a command at all?" and it is the last line of defence before
 * a write. The install-time CONSENT TOKEN (a separate, later mechanism) is a UX
 * gate: it proves the founder actually saw the exact command they are installing.
 * Consent is NOT a substitute for this check and must never be accepted in its
 * place — a founder can consent to a command they are not authorized to run on a
 * shared host, and an unverified catalog entry's command is untrusted regardless
 * of how clearly it was displayed. Both gates run; neither subsumes the other.
 *
 * CALL IT BEFORE ANY WRITE. It is deliberately NOT inside `createConnector`,
 * because it needs the catalog trust tier — which only the caller knows, and
 * which does not exist at all for a BYO connector.
 *
 * C4 — TIER AWARENESS: the catalog exemption requires `trustTier === "verified"`.
 * The gate previously keyed on `source` alone while its comment claimed
 * "verified"; that was safe only for as long as no route could construct a
 * `catalog` source. The catalog install route does exactly that, and the catalog
 * schema admits `community`/`unverified` tiers, so source alone would let an
 * unverified third-party `npx` command spawn a process on a shared host.
 * `trustTier` is optional and FAIL-CLOSED: an omitted or unrecognised tier is
 * never treated as verified.
 *
 * Exported so its full truth table is unit-tested directly.
 */
export function isTransportAllowed(
  transport: string,
  deploymentMode: string,
  source: string,
  trustTier?: string,
  sandboxTarget = false,
): boolean {
  if (transport !== "stdio") return true; // http is always fine
  if (deploymentMode === "local_trusted") return true; // host is the founder's own machine
  if (source === "catalog" && trustTier === "verified") return true; // verified catalog entries only (C4)
  // U11: a per-run E2B sandbox IS the containment that makes an npx/uvx stdio
  // server safe on shared infra. Admissible ONLY when this run resolved a
  // sandbox execution target — never for an unsandboxed shared-host run.
  if (sandboxTarget) return true;
  return false;
}

export function assertTransportAllowed(
  transport: string,
  deploymentMode: string,
  source: string,
  trustTier?: string,
  sandboxTarget = false,
): void {
  if (isTransportAllowed(transport, deploymentMode, source, trustTier, sandboxTarget)) return;
  throw badRequest(
    "Only remote HTTP connectors can be added in this deployment. stdio connectors run a " +
      "command on the AoA host and are restricted to verified catalog entries.",
  );
}
