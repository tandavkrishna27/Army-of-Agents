#!/usr/bin/env node
/**
 * check-egress-bypass-vectors.mjs
 *
 * DEP-008 §2.6 — independent reference verifier for the hostile egress-BYPASS
 * corpus `tests/fixtures/egress-bypass/v1/vectors.json`. It EXTENDS the DAT-005
 * default-deny egress gate with adversarial SSRF/rebind spellings (hex-mapped
 * IPv4-in-IPv6 metadata/control-plane, first-word-zero IPv6, bracket/case/whitespace
 * obfuscation, decimal/octal-looking octets that must fail closed, DNS-rebind
 * [public,private] multi-homing) and an INJECTED control-plane deny set.
 *
 * It REUSES the proven independent reference classifier from
 * `check-egress-policy-vectors.mjs` (the same from-scratch re-derivation DAT-005
 * pins to its fixture) — NOT the real server classifier — so this gate and the real
 * `classifyEgressDestination` (bound in server/src/__tests__/egress-bypass.test.ts)
 * are two independent implementations pinned to ONE corpus; neither can silently
 * diverge on which bypass spellings are refused and with which class.
 *
 * Anti-vacuity: every `control_plane` vector is re-classified with an EMPTY deny
 * set and MUST cease to be `control_plane` — proving the injected
 * AOA_CONTROL_PLANE_DENY_CIDRS is load-bearing (a public control-plane IP cannot be
 * denied by chance).
 *
 * Usage:
 *   node scripts/check-egress-bypass-vectors.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  EgressPolicyVectorError,
  NETWORK_DENIAL_CLASSES,
  classifyEgress,
} from "./check-egress-policy-vectors.mjs";

export const FIXTURE_SEGMENTS = ["tests", "fixtures", "egress-bypass", "v1", "vectors.json"];

export function verifyBypassFixture(fixture) {
  const problems = [];
  if (fixture?.version !== "1") problems.push(`version must be "1", got ${JSON.stringify(fixture?.version)}`);
  if (fixture?.schema !== "aoa-egress-bypass-vectors/v1") problems.push("schema id mismatch");
  const ctx = fixture?.context;
  if (typeof ctx !== "object" || ctx === null) problems.push("context missing");
  const allow = Array.isArray(ctx?.allow) ? ctx.allow : null;
  const controlPlaneCidrs = Array.isArray(ctx?.controlPlaneCidrs) ? ctx.controlPlaneCidrs : null;
  if (!allow) problems.push("context.allow must be an array");
  if (!controlPlaneCidrs) problems.push("context.controlPlaneCidrs must be an array");

  const allows = Array.isArray(fixture?.allowVectors) ? fixture.allowVectors : null;
  const denies = Array.isArray(fixture?.denyVectors) ? fixture.denyVectors : null;
  if (!allows || allows.length === 0) problems.push("allowVectors must be a non-empty array");
  if (!denies || denies.length === 0) problems.push("denyVectors must be a non-empty array");

  const seen = new Set();
  for (const [i, v] of (allows ?? []).entries()) {
    const label = v?.name ?? `#${i}`;
    if (!v?.name || seen.has(v.name)) problems.push(`allow vector ${label}: missing or duplicate name`);
    seen.add(v?.name);
    const decision = classifyEgress(v.requestedUrl, v.resolvedAddrs, allow ?? [], controlPlaneCidrs ?? []);
    if (decision !== "allow") problems.push(`allow vector ${label}: reference decided ${decision}, expected allow`);
  }

  let controlPlaneVectors = 0;
  for (const [i, r] of (denies ?? []).entries()) {
    const label = r?.name ?? `#${i}`;
    if (!r?.name || seen.has(r.name)) problems.push(`deny vector ${label}: missing or duplicate name`);
    seen.add(r?.name);
    if (typeof r?.class !== "string") { problems.push(`deny vector ${label}: missing class`); continue; }
    if (!NETWORK_DENIAL_CLASSES.includes(r.class)) problems.push(`deny vector ${label}: class ${r.class} not a frozen NETWORK_DENIAL_CLASS`);
    const decision = classifyEgress(r.requestedUrl, r.resolvedAddrs, allow ?? [], controlPlaneCidrs ?? []);
    if (decision === "allow") {
      problems.push(`deny vector ${label}: reference ALLOWED a destination that must be refused`);
    } else if (decision !== r.class) {
      problems.push(`deny vector ${label}: reference decided ${decision}, expected ${r.class}`);
    }
    // Anti-vacuity: a control_plane denial must depend on the INJECTED deny set,
    // AND must be the SOLE reason the destination is denied — with an empty deny
    // set the address must classify as `allow` (not merely a different deny class
    // like `private`/`metadata`, which would mean the injection is inert).
    if (r.class === "control_plane") {
      controlPlaneVectors += 1;
      const withoutInjection = classifyEgress(r.requestedUrl, r.resolvedAddrs, allow ?? [], []);
      if (withoutInjection !== "allow") {
        problems.push(`deny vector ${label}: with an EMPTY deny set it classifies ${withoutInjection}, not allow — the injected AOA_CONTROL_PLANE_DENY_CIDRS is not the load-bearing denial (vacuous)`);
      }
    }
  }
  if (controlPlaneVectors === 0) {
    problems.push("corpus must include at least one control_plane bypass vector (injected-deny-set coverage)");
  }

  if (problems.length > 0) {
    throw new EgressPolicyVectorError(`egress-bypass fixture invalid:\n - ${problems.join("\n - ")}`);
  }
  return { allows: allows.length, denies: denies.length, controlPlaneVectors };
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadFixture(root = repoRoot()) {
  return JSON.parse(fs.readFileSync(path.join(root, ...FIXTURE_SEGMENTS), "utf8"));
}

function main() {
  let fixture;
  try {
    fixture = loadFixture();
  } catch (error) {
    console.error(`egress-bypass vectors: FAIL — cannot read/parse fixture: ${error.message}`);
    process.exit(1);
  }
  try {
    const { allows, denies, controlPlaneVectors } = verifyBypassFixture(fixture);
    console.log(`egress-bypass vectors: PASS (${allows} allow, ${denies} deny, ${controlPlaneVectors} injected-control-plane)`);
  } catch (error) {
    console.error(`egress-bypass vectors: FAIL — ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
