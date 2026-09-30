/**
 * REL-003 (E11) Lane D — rollout order supports N-1 workers (DR07 rollout half).
 *
 * Drives the EXPORTED aggregate `evaluateStagingManifestInvariants` (B2:
 * `checkRolloutPolicy` is private) over the real `docker-compose.staging.yml`, and
 * proves the FROZEN-v1 identical N/N-1 baseline via the protocol-version negotiation
 * (D6). Pure/node — no DB, runs everywhere. The positive control (a broken rollout
 * fixture produces a violation) proves the aggregate's rollout check actually fires.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseYaml } from "../../../scripts/lib/yaml-lite.mjs";
import { evaluateStagingManifestInvariants } from "../../../scripts/lib/staging-manifest-invariants.mjs";
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  negotiateProtocolVersion,
} from "@armyofagents/worker-protocol";

function realStagingCompose(): Record<string, unknown> {
  const path = fileURLToPath(new URL("../../../docker-compose.staging.yml", import.meta.url));
  return parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("REL-003 Lane D — N-1 rollout policy over the real staging manifest", () => {
  it("I12: the real docker-compose.staging.yml satisfies the rollout policy (parallelism 1, bounded order/failure-ratio)", () => {
    const compose = realStagingCompose();
    const { violations } = evaluateStagingManifestInvariants(compose);
    // The real staging manifest passes every invariant — in particular the N/N-1
    // rollout policy (checkRolloutPolicy: parallelism 1 on every CP + worker).
    expect(violations).toEqual([]);
  });

  it("positive control: a worker rollout with unbounded parallelism (4) breaks N-1 and is flagged", () => {
    const compose = structuredClone(realStagingCompose()) as {
      services: Record<string, { deploy: { update_config: { parallelism: number } } }>;
    };
    compose.services["worker-b2"]!.deploy.update_config.parallelism = 4;
    const { violations } = evaluateStagingManifestInvariants(compose);
    // Proves the rollout check runs: parallelism 4 admits >1 version-skewed replica.
    expect(violations.some((v: string) => /parallelism/i.test(v))).toBe(true);
  });

  it("positive control: a control-plane missing its rolling-update policy is flagged", () => {
    const compose = structuredClone(realStagingCompose()) as {
      services: Record<string, { deploy: { update_config?: unknown } }>;
    };
    delete compose.services["control-plane"]!.deploy.update_config;
    const { violations } = evaluateStagingManifestInvariants(compose);
    expect(violations.some((v: string) => /rolling-update|update_config/i.test(v))).toBe(true);
  });

  it("I12 (baseline identity): worker-protocol is FROZEN v1 — N and N-1 negotiate the identical single version", () => {
    // The initial distributed release runs the same FROZEN-v1 baseline on both
    // sides (D6): the negotiated protocol is a single version, so an N worker and an
    // N-1 worker are byte-identical and interchangeable.
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MIN_PROTOCOL_VERSION).toBe(1);
    // N (control-plane advertises {1,1}) and N-1 (worker advertises {1,1}) → 1.
    expect(negotiateProtocolVersion({ min: 1, max: 1 }, { min: 1, max: 1 })).toBe(1);
    // Even a forward-compatible skew ({1,2} vs {1,1}) negotiates DOWN to the shared
    // frozen v1 — the N-1 rollout case never forces a version a peer cannot speak.
    expect(negotiateProtocolVersion({ min: 1, max: 2 }, { min: 1, max: 1 })).toBe(1);
  });
});
