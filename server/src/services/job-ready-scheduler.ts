import { NOOP_JOB_CONTROL_METRICS, type JobControlMetrics } from "./job-control-metrics.js";

export interface JobReadySignal {
  organizationId: string;
  targetId: string;
}

export interface JobReadyScheduler {
  signal(signal: JobReadySignal): boolean;
  consume(organizationId: string, targetId: string): boolean;
  size(): { organizations: number; targets: number; signals: number };
}

interface StoredSignal {
  expiresAt: number;
}

const MAX_ORGANIZATIONS = 32;
const MAX_TARGETS_PER_ORGANIZATION = 1_024;
const MAX_SIGNALS_GLOBAL = 1_024;
const MAX_SIGNAL_TTL_MS = 300_000;

function boundedPositiveInteger(
  name: string,
  value: number | undefined,
  defaultValue: number,
  ceiling: number,
): number {
  const configured = value ?? defaultValue;
  if (!Number.isFinite(configured) || !Number.isInteger(configured) || configured <= 0) {
    throw new Error(`${name}_must_be_a_finite_positive_integer`);
  }
  return Math.min(configured, ceiling);
}

/**
 * A bounded, process-local readiness accelerator. Signals contain only the
 * exact tenant/target key and never carry lease authority or candidate order.
 */
export function createJobReadyScheduler(input: {
  maxOrganizationShards?: number;
  maxTargetsPerOrganization?: number;
  maxSignalsGlobal?: number;
  signalTtlMs?: number;
  monotonicNow?: () => number;
  metrics?: JobControlMetrics;
} = {}): JobReadyScheduler {
  const metrics = input.metrics ?? NOOP_JOB_CONTROL_METRICS;
  const maxOrganizations = boundedPositiveInteger(
    "maxOrganizationShards",
    input.maxOrganizationShards,
    32,
    MAX_ORGANIZATIONS,
  );
  const maxTargetsPerOrganization = boundedPositiveInteger(
    "maxTargetsPerOrganization",
    input.maxTargetsPerOrganization,
    128,
    MAX_TARGETS_PER_ORGANIZATION,
  );
  const maxSignalsGlobal = boundedPositiveInteger(
    "maxSignalsGlobal",
    input.maxSignalsGlobal,
    1_024,
    MAX_SIGNALS_GLOBAL,
  );
  const signalTtlMs = boundedPositiveInteger(
    "signalTtlMs",
    input.signalTtlMs,
    30_000,
    MAX_SIGNAL_TTL_MS,
  );
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const organizations = new Map<string, Map<string, StoredSignal>>();
  let totalSignals = 0;

  function cleanupExpired(now: number): void {
    let expired = 0;
    for (const [organizationId, targets] of organizations) {
      for (const [targetId, stored] of targets) {
        if (stored.expiresAt > now) continue;
        targets.delete(targetId);
        totalSignals -= 1;
        expired += 1;
      }
      if (targets.size === 0) organizations.delete(organizationId);
    }
    if (expired > 0) metrics.schedulerExpiry({ count: expired });
  }

  return {
    signal(signal) {
      const now = monotonicNow();
      cleanupExpired(now);

      const existingOrganization = organizations.get(signal.organizationId);
      if (existingOrganization?.has(signal.targetId)) {
        // Duplicate publication is idempotent and deliberately does not extend
        // expiry, otherwise replay from an offline target could pin memory.
        return true;
      }
      if (!existingOrganization && organizations.size >= maxOrganizations) {
        metrics.schedulerCapacityReject({ scope: "organization" });
        return false;
      }
      if (totalSignals >= maxSignalsGlobal) {
        metrics.schedulerCapacityReject({ scope: "global" });
        return false;
      }
      if (existingOrganization && existingOrganization.size >= maxTargetsPerOrganization) {
        metrics.schedulerCapacityReject({ scope: "target" });
        return false;
      }

      const targets = existingOrganization ?? new Map<string, StoredSignal>();
      if (!existingOrganization) organizations.set(signal.organizationId, targets);
      targets.set(signal.targetId, { expiresAt: now + signalTtlMs });
      totalSignals += 1;
      return true;
    },

    consume(organizationId, targetId) {
      cleanupExpired(monotonicNow());
      const targets = organizations.get(organizationId);
      if (!targets?.delete(targetId)) return false;
      totalSignals -= 1;
      if (targets.size === 0) organizations.delete(organizationId);
      return true;
    },

    size() {
      cleanupExpired(monotonicNow());
      const cardinality = {
        organizations: organizations.size,
        targets: totalSignals,
        signals: totalSignals,
      };
      metrics.schedulerCardinality(cardinality);
      return cardinality;
    },
  };
}
