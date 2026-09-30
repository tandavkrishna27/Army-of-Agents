import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ATTEMPT_STATUSES,
  BROWSER_SESSION_STATUSES,
  JOB_STATUSES,
  LEASE_STATUSES,
  SERVICE_DESIRED_STATES,
  SERVICE_INSTANCE_STATUSES,
  canTransitionAttemptStatus,
  canTransitionBrowserSessionStatus,
  canTransitionJobStatus,
  canTransitionLeaseStatus,
  canTransitionServiceDesiredState,
  canTransitionServiceInstanceStatus,
  workloadTypeSchema,
} from "./states.js";

// -----------------------------------------------------------------------------
// Illustrative expected maps. Per E1-D001 these are a human-readable guide; the
// machine-readable docs/architecture/distributed-execution-lifecycles.json is
// the sole authority and is cross-checked byte-for-byte below.
// -----------------------------------------------------------------------------

const JOB_TRANSITION_REASONS = ["normal", "cancel", "non_retryable_failure", "policy_exhausted"] as const;

const jobExpected = {
  queued: ["running", "cancel_requested", "cancelled"],
  running: ["cancel_requested", "succeeded", "failed", "dead_letter"],
  cancel_requested: ["cancelled", "failed", "dead_letter"],
  succeeded: [],
  failed: [],
  cancelled: [],
  dead_letter: [],
} as const;

const attemptExpected = {
  pending: ["offered", "cancelled", "expired"],
  offered: ["leased", "expired", "cancelled"],
  leased: ["running", "cancel_requested", "expired", "cancelled"],
  running: ["cancel_requested", "succeeded", "failed", "expired"],
  cancel_requested: ["cancelled", "succeeded", "failed", "expired"],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
} as const;

const leaseExpected = {
  offered: ["active", "expired", "revoked"],
  active: ["released", "expired", "revoked"],
  released: [],
  expired: [],
  revoked: [],
} as const;

const browserExpected = {
  queued: ["leased", "cancelled", "expired"],
  leased: ["starting", "cancel_requested", "cancelled", "expired"],
  starting: ["active", "cancel_requested", "failed", "cancelled", "expired"],
  active: ["waiting_approval", "cancel_requested", "succeeded", "failed", "cancelled", "expired"],
  waiting_approval: ["active", "cancel_requested", "failed", "cancelled", "expired"],
  cancel_requested: ["cancelled", "succeeded", "failed", "expired"],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
} as const;

const serviceDesiredExpected = {
  running: ["paused", "stopped", "deleted"],
  paused: ["running", "stopped", "deleted"],
  stopped: ["running", "deleted"],
  deleted: [],
} as const;

const serviceInstanceExpected = {
  pending: ["leased", "failed", "lost"],
  leased: ["starting", "stopping", "failed", "lost"],
  starting: ["healthy", "unhealthy", "stopping", "failed", "lost"],
  healthy: ["unhealthy", "stopping", "failed", "lost"],
  unhealthy: ["healthy", "stopping", "failed", "lost"],
  stopping: ["stopped", "failed", "lost"],
  stopped: [],
  failed: [],
  lost: [],
} as const;

// A uniform accessor over each machine's predicate. The `edge` closure hides the
// job reason parameter (permitted by SOME legal reason) so the parity and
// forbidden-edge logic can treat every machine identically.
type MachineDescriptor = {
  readonly jsonKey: string;
  readonly states: readonly string[];
  readonly edge: (from: string, to: string) => boolean;
};

const jobEdge = (from: string, to: string): boolean =>
  JOB_TRANSITION_REASONS.some((reason) =>
    canTransitionJobStatus(from as never, to as never, { reason }),
  );

const MACHINES: readonly MachineDescriptor[] = [
  { jsonKey: "job", states: JOB_STATUSES, edge: jobEdge },
  {
    jsonKey: "attempt",
    states: ATTEMPT_STATUSES,
    edge: (from, to) => canTransitionAttemptStatus(from as never, to as never),
  },
  {
    jsonKey: "lease",
    states: LEASE_STATUSES,
    edge: (from, to) => canTransitionLeaseStatus(from as never, to as never),
  },
  {
    jsonKey: "browserSession",
    states: BROWSER_SESSION_STATUSES,
    edge: (from, to) => canTransitionBrowserSessionStatus(from as never, to as never),
  },
  {
    jsonKey: "serviceDesired",
    states: SERVICE_DESIRED_STATES,
    edge: (from, to) => canTransitionServiceDesiredState(from as never, to as never),
  },
  {
    jsonKey: "serviceInstance",
    states: SERVICE_INSTANCE_STATUSES,
    edge: (from, to) => canTransitionServiceInstanceStatus(from as never, to as never),
  },
];

const machineByKey = new Map<string, MachineDescriptor>(MACHINES.map((m) => [m.jsonKey, m]));

// Exhaustively assert a reasonless machine's predicate against an expected map.
function assertCartesian(
  states: readonly string[],
  expected: Readonly<Record<string, readonly string[]>>,
  predicate: (from: string, to: string) => boolean,
): number {
  let assertions = 0;
  for (const from of states) {
    for (const to of states) {
      assertions += 1;
      expect(predicate(from, to), `${from} -> ${to}`).toBe(
        (expected[from] as readonly string[]).includes(to),
      );
    }
  }
  return assertions;
}

describe("protocol state machines", () => {
  it("accepts only the three locked workload types", () => {
    expect(workloadTypeSchema.parse("batch")).toBe("batch");
    expect(workloadTypeSchema.parse("browser_session")).toBe("browser_session");
    expect(workloadTypeSchema.parse("service")).toBe("service");
    expect(workloadTypeSchema.safeParse("daemon").success).toBe(false);
  });

  it("matches every allowed and forbidden job transition", () => {
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const permittedBySomeReason = JOB_TRANSITION_REASONS.some((reason) =>
          canTransitionJobStatus(from, to, { reason }),
        );
        expect(permittedBySomeReason, `${from} -> ${to}`).toBe(
          (jobExpected[from] as readonly string[]).includes(to),
        );
      }
    }
  });

  it("keeps all terminal states immutable", () => {
    for (const status of ["succeeded", "failed", "cancelled", "dead_letter"] as const) {
      expect(
        JOB_STATUSES.every((to) => !canTransitionJobStatus(status, to, { reason: "normal" })),
      ).toBe(true);
    }
  });

  it("guards terminal failure reasons", () => {
    expect(canTransitionJobStatus("running", "dead_letter", { reason: "normal" })).toBe(false);
    expect(canTransitionJobStatus("running", "dead_letter", { reason: "cancel" })).toBe(false);
    expect(canTransitionJobStatus("running", "dead_letter", { reason: "non_retryable_failure" })).toBe(false);
    expect(canTransitionJobStatus("running", "dead_letter", { reason: "policy_exhausted" })).toBe(true);
    expect(canTransitionJobStatus("running", "failed", { reason: "normal" })).toBe(false);
    expect(canTransitionJobStatus("running", "failed", { reason: "cancel" })).toBe(false);
    expect(canTransitionJobStatus("running", "failed", { reason: "policy_exhausted" })).toBe(false);
    expect(canTransitionJobStatus("running", "failed", { reason: "non_retryable_failure" })).toBe(true);
    // The same guards apply from cancel_requested.
    expect(canTransitionJobStatus("cancel_requested", "dead_letter", { reason: "policy_exhausted" })).toBe(true);
    expect(canTransitionJobStatus("cancel_requested", "dead_letter", { reason: "normal" })).toBe(false);
    expect(canTransitionJobStatus("cancel_requested", "failed", { reason: "non_retryable_failure" })).toBe(true);
    expect(canTransitionJobStatus("cancel_requested", "failed", { reason: "normal" })).toBe(false);
    // A guarded reason cannot conjure a non-existent edge (queued has no failed/dead_letter edge).
    expect(canTransitionJobStatus("queued", "failed", { reason: "non_retryable_failure" })).toBe(false);
    expect(canTransitionJobStatus("queued", "dead_letter", { reason: "policy_exhausted" })).toBe(false);
  });

  it("matches every allowed and forbidden attempt transition", () => {
    const count = assertCartesian(ATTEMPT_STATUSES, attemptExpected, canTransitionAttemptStatus);
    expect(count).toBe(ATTEMPT_STATUSES.length * ATTEMPT_STATUSES.length);
  });

  it("matches every allowed and forbidden lease transition", () => {
    const count = assertCartesian(LEASE_STATUSES, leaseExpected, canTransitionLeaseStatus);
    expect(count).toBe(LEASE_STATUSES.length * LEASE_STATUSES.length);
  });

  it("matches every allowed and forbidden browser-session transition", () => {
    const count = assertCartesian(
      BROWSER_SESSION_STATUSES,
      browserExpected,
      canTransitionBrowserSessionStatus,
    );
    expect(count).toBe(BROWSER_SESSION_STATUSES.length * BROWSER_SESSION_STATUSES.length);
  });

  it("matches every allowed and forbidden service desired-state transition", () => {
    const count = assertCartesian(
      SERVICE_DESIRED_STATES,
      serviceDesiredExpected,
      canTransitionServiceDesiredState,
    );
    expect(count).toBe(SERVICE_DESIRED_STATES.length * SERVICE_DESIRED_STATES.length);
  });

  it("matches every allowed and forbidden service-instance transition", () => {
    const count = assertCartesian(
      SERVICE_INSTANCE_STATUSES,
      serviceInstanceExpected,
      canTransitionServiceInstanceStatus,
    );
    expect(count).toBe(SERVICE_INSTANCE_STATUSES.length * SERVICE_INSTANCE_STATUSES.length);
  });

  it("keeps every non-job terminal state immutable", () => {
    const cases: ReadonlyArray<{ states: readonly string[]; terminals: readonly string[]; edge: (f: string, t: string) => boolean }> = [
      { states: ATTEMPT_STATUSES, terminals: ["succeeded", "failed", "cancelled", "expired"], edge: (f, t) => canTransitionAttemptStatus(f as never, t as never) },
      { states: LEASE_STATUSES, terminals: ["released", "expired", "revoked"], edge: (f, t) => canTransitionLeaseStatus(f as never, t as never) },
      { states: BROWSER_SESSION_STATUSES, terminals: ["succeeded", "failed", "cancelled", "expired"], edge: (f, t) => canTransitionBrowserSessionStatus(f as never, t as never) },
      { states: SERVICE_DESIRED_STATES, terminals: ["deleted"], edge: (f, t) => canTransitionServiceDesiredState(f as never, t as never) },
      { states: SERVICE_INSTANCE_STATUSES, terminals: ["stopped", "failed", "lost"], edge: (f, t) => canTransitionServiceInstanceStatus(f as never, t as never) },
    ];
    for (const { states, terminals, edge } of cases) {
      for (const terminal of terminals) {
        expect(states.every((to) => !edge(terminal, to)), `terminal ${terminal}`).toBe(true);
      }
    }
  });
});

// -----------------------------------------------------------------------------
// E1-D001 — byte-for-byte semantic parity against the authoritative E0 JSON.
// The runtime states.ts embeds the maps as literals (no fs); this .test.ts is
// excluded from tsc + the boundary scan, so it may use node:fs to load the JSON.
// -----------------------------------------------------------------------------

type LifecycleJson = {
  lifecycles: Record<
    string,
    {
      states: string[];
      terminal: string[];
      guards: Record<string, string>;
      allowed: Array<{ from: string; to: string; reason?: string }>;
    }
  >;
  forbiddenCrossLifecycleEdges: Array<{ from: string; to: string; reason: string }>;
};

const lifecycleJson = JSON.parse(
  readFileSync(
    new URL("../../../docs/architecture/distributed-execution-lifecycles.json", import.meta.url),
    "utf8",
  ),
) as LifecycleJson;

// Reconstruct the embedded machine (edges/guards/terminal) purely from the
// exported predicates + status arrays, then compare against the JSON authority.
function reconstructEdges(machine: MachineDescriptor): string[] {
  const edges: string[] = [];
  for (const from of machine.states) {
    for (const to of machine.states) {
      if (machine.edge(from, to)) edges.push(`${from}->${to}`);
    }
  }
  return edges.sort();
}

function reconstructTerminal(machine: MachineDescriptor): string[] {
  return machine.states.filter((from) => !machine.states.some((to) => machine.edge(from, to))).sort();
}

// Job is the only guarded machine; reconstruct guards from the predicate's
// reason sensitivity (a guarded target is permitted by exactly one reason).
function reconstructJobGuards(): Record<string, string> {
  const guards: Record<string, string> = {};
  for (const to of JOB_STATUSES) {
    const permittingReasons = new Set<string>();
    let reachable = false;
    for (const from of JOB_STATUSES) {
      const reasons = JOB_TRANSITION_REASONS.filter((reason) =>
        canTransitionJobStatus(from, to, { reason }),
      );
      if (reasons.length > 0) reachable = true;
      for (const reason of reasons) permittingReasons.add(reason);
    }
    if (reachable && permittingReasons.size === 1) {
      guards[to] = [...permittingReasons][0]!;
    }
  }
  return guards;
}

describe("lifecycle parity with the E0 JSON authority (E1-D001)", () => {
  it("loads the authoritative lifecycle contract with all six machines", () => {
    for (const key of ["job", "attempt", "lease", "browserSession", "serviceDesired", "serviceInstance"]) {
      expect(lifecycleJson.lifecycles[key], key).toBeDefined();
      expect(machineByKey.has(key), key).toBe(true);
    }
  });

  for (const machine of MACHINES) {
    it(`${machine.jsonKey}: states, allowed edges, guards, and terminal set equal the JSON exactly`, () => {
      const json = lifecycleJson.lifecycles[machine.jsonKey]!;

      // States/enum members equal the JSON states (exact order + membership).
      expect([...machine.states]).toEqual(json.states);

      // Allowed edges (grouped by from) equal the JSON allowed edges exactly.
      const jsonEdges = json.allowed.map((edge) => `${edge.from}->${edge.to}`).sort();
      expect(reconstructEdges(machine)).toEqual(jsonEdges);

      // Terminal set equals the JSON terminal array.
      expect(reconstructTerminal(machine)).toEqual([...json.terminal].sort());

      // Guards equal the JSON guards (job is guarded; all others are {}).
      const guards = machine.jsonKey === "job" ? reconstructJobGuards() : {};
      expect(guards).toEqual(json.guards);
    });
  }

  it("permits no forbidden cross-lifecycle edge", () => {
    expect(lifecycleJson.forbiddenCrossLifecycleEdges.length).toBeGreaterThan(0);
    for (const edge of lifecycleJson.forbiddenCrossLifecycleEdges) {
      const [fromMachine, fromState] = edge.from.split(":");
      const [toMachine, toState] = edge.to.split(":");

      // Genuinely cross-lifecycle: the two endpoints belong to distinct machines.
      expect(fromMachine, `${edge.from} -> ${edge.to}`).not.toBe(toMachine);

      const from = machineByKey.get(fromMachine!);
      const to = machineByKey.get(toMachine!);
      expect(from, `unknown machine ${fromMachine}`).toBeDefined();
      expect(to, `unknown machine ${toMachine}`).toBeDefined();

      // The referenced endpoints are real members of their own machines.
      expect(from!.states).toContain(fromState);
      expect(to!.states).toContain(toState);

      // If the target state is foreign to the from-machine, its predicate rejects it.
      if (!from!.states.includes(toState!)) {
        expect(from!.edge(fromState!, toState!), `${edge.from} -> ${edge.to}`).toBe(false);
      }
      // If the source state is foreign to the to-machine, its predicate rejects it.
      if (!to!.states.includes(fromState!)) {
        expect(to!.edge(fromState!, toState!), `${edge.from} -> ${edge.to}`).toBe(false);
      }
    }
  });

  it("never permits a transition into another lifecycle's exclusive state", () => {
    const allStates = new Set(MACHINES.flatMap((m) => m.states));
    for (const machine of MACHINES) {
      const ownStates = new Set(machine.states);
      const foreignStates = [...allStates].filter((state) => !ownStates.has(state));
      for (const from of machine.states) {
        for (const foreign of foreignStates) {
          expect(machine.edge(from, foreign), `${machine.jsonKey}: ${from} -> foreign ${foreign}`).toBe(
            false,
          );
        }
      }
    }
  });
});
