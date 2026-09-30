# AoA Multi-Tenant Phase 5 — Execution-Target Registry + gVisor Provider + Route-by-Credential + Per-Org Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make execution targets first-class (tenant-scoped `execution_targets` registry), add a self-hosted gVisor sandbox backend by hardening the Docker run path, route runs to a target by credential kind (business key → shared pool, personal subscription → dedicated target), and add a light per-Organization concurrency cap + read-only org spend rollup — in one branch/one PR, preserving self-hosted single-tenant.

**Architecture:** A new tenant-scoped `execution_targets` table is the fleet inventory; `environments` stays company-scoped and gains a nullable `execution_target_id` FK (null = route by credential). The gVisor backend reuses the existing `sandbox-docker` transport — `buildDockerRunArgs` gains an opt-in, default-OFF `isolation`/`runtime` profile that emits the hardened flag set (`--runtime=runsc`, `--user`, `--cap-drop=ALL`, `--read-only`, `--tmpfs`, `--memory`/`--cpus`/`--pids-limit`, `--security-opt no-new-privileges`, `--network none`) and makes the `--add-host host-gateway` SSRF vector conditional. A new `execution-target-resolver` chooses the target from the P4-selected credential kind and replaces the current hard throw in `heartbeat.ts`. A per-org clamp mirrors the heartbeat per-agent clamp.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Express 5, Vitest, React/Vite (UI). Contract-sync across `packages/db` → `packages/shared` → `server` → `ui`. Windows CI skips `*.integration.test.ts` + e2e, so every new test is a pure-function or mock-DB unit test.

---

## Locked decisions (do NOT re-open)

- Tenant = **Organization** (`organizations` / `organization_id`). P1 merges before P5, so `execution_targets.organization_id` is a **real nullable FK now** → `organizations.id` `ON DELETE SET NULL` (M6-FK; nullable = system/shared rows). Per-org cap column = `organizations.concurrency_cap` (P1 adds it); Phase 5 reads it (falling back to the constant default when unset).
- NEW `execution_targets` table + nullable `environments.execution_target_id` FK + a seeded `control-plane` system row (back-compat keystone).
- gVisor = `runsc` baked into a golden worker image; `execution_targets.capabilities.runtimes` advertises `"runsc"`. Pooled gVisor = ONE logical-pool row. Dedicated targets = semi-manual (owner pastes slug + endpoint; worker self-registers/heartbeats `last_seen_at`).
- Egress default `--network none`. `bridge` is permitted for the pool ONLY with the worker-image egress firewall applied (M7 — a HARD Task-0/worker-image deliverable this phase: DENY RFC1918 + `169.254.169.254` + control-plane, ALLOW provider hosts). The app layer does NOT filter egress. `--add-host host.docker.internal:host-gateway` becomes CONDITIONAL (callback bridge started AND target opts in) — **this SSRF fix ships in THIS PR** — but is one route removed, not egress filtering.
- Hardening is opt-in / default-OFF. Self-hosted single-tenant local driver unchanged. Drizzle only; never hand-write SQL migrations. `cloud_auth` deployment mode exists. RLS is app-layer.
- Task 0 (gVisor runsc spike) is a **go/no-go gate**.

## Existing patterns to follow (read these first)

- `packages/adapter-utils/src/execution-target.ts:149-178` — `buildDockerRunArgs` (unhardened) and `:589-610` the docker invoke; `:28-84` `resolveAdapterExecutionTarget`; `:168-169` the unconditional `--add-host`.
- `packages/adapter-utils/src/execution-target-docker.test.ts:48-96` — the **exact-array** `.toEqual([...])` assertions your hardening will change; `:98-186` the mocked-`run` sandbox-docker tests.
- `packages/adapter-utils/src/types.ts:52-61` — `AdapterDockerExecutionTarget`.
- `server/src/services/sandbox-provider-runtime.ts:339-529` `createE2bSandboxRuntimeProvider` and `:531-541` how providers register (peer for `gvisor`).
- `server/src/services/environment-runtime.ts:182-201` `resolveDockerSandboxConfig` / `isDockerSandboxProvider`; `:382-386` `getDriver`.
- `server/src/services/environment-resolver.ts:30-53` `resolveEnvironmentRuntimeConfig`.
- `server/src/services/heartbeat.ts:179-180,300-303` clamp constants; `:2154-2160` `countRunningRunsForAgent`; `:2496-2503` `startNextQueuedRunForAgent` gate; `:590-600` `applyEnvironmentRuntimeTarget`; `:2946` resolve site. NOTE: the `:3992-4035` subscription block + its `:4012-4016` throw are on the PRE-P4 tree — **P4 Task 12(b) deletes them** into a `legacySubscriptionEnv` closure. Phase 5 lands after P4 and must not reference those line numbers.
- `server/src/services/provider-credential-bindings.ts:56-120` `chooseGovernedSubscriptionBinding`.
- `server/src/__tests__/helpers/drizzle-mock.ts` — `makeTableProxy` + `drizzleOperatorStubs`; tests declare a local sequence-DB (see NOTE at `:115`).
- `packages/db/src/schema/index.ts:135` environments export; `:49` costEvents export.

## File Structure (created / modified)

- Create `packages/db/src/schema/execution_targets.ts`; modify `packages/db/src/schema/environments.ts`, `packages/db/src/schema/index.ts`.
- Modify `packages/shared/src/constants.ts`, `packages/shared/src/validators/environment.ts`; create `packages/shared/src/validators/execution-target.ts`; modify `packages/shared/src/types` barrel.
- Modify `packages/adapter-utils/src/types.ts`, `packages/adapter-utils/src/execution-target.ts`, `packages/adapter-utils/src/execution-target-docker.test.ts`.
- Create `server/src/services/execution-targets.ts`, `server/src/services/execution-target-resolver.ts`, `server/src/services/gvisor-sandbox-provider.ts`, `server/src/services/org-concurrency.ts`, `server/src/services/org-spend.ts`; modify `server/src/services/environment-runtime.ts`, `server/src/services/heartbeat.ts`.
- Create `server/src/routes/execution-targets.ts`, `server/src/routes/org-spend.ts` (router-factory `({ db })` pattern per `server/src/routes/environments.ts:29`); mount both in `server/src/app.ts` inside `createApp(db, ...)`.
- Modify `ui/src/components/settings/sections/EnvironmentsSection.tsx` (+ a pure mapping helper file `ui/src/components/settings/sections/environment-target-form.ts`).
- Docs: `docs/architecture/decisions.md`, `docs/deploy/environment-variables.md`, create `docs/aoa/guides/gvisor-worker-image.md`.
- Generated migrations under `packages/db/src/migrations/` (+ `meta/_journal.json`, `meta/*_snapshot.json`) via `pnpm db:generate`.

**Migration numbering (generate strictly in phase order, AFTER P1/P3/P4):** latest on branch is `0186_cold_psylocke`. P1 = `0188`, P3 = `0189`, P4 = `0190`. **Phase 5 = `0191` (execution_targets) + `0192` (environments.execution_target_id) — or a single bundled `0191` if both schema changes are generated in one `pnpm db:generate` pass.** Do not generate P5 migrations until P1-P4 have taken 0188-0190, or the ordinals will collide.

**Cross-phase ownership (do NOT duplicate):** `heartbeat.ts:2946-4035` is JOINTLY owned with Phase 4 and executed **P4-FIRST**. P4 Task 12(b) DELETES the `:3991-4035` subscription block and folds its subscription-home logic into a `legacySubscriptionEnv` closure (the old dedicated-target throw now lives inside that closure's `local` branch). Phase 5 Task 9 therefore builds on P4's **post-delete** heartbeat — it must NOT assume the `:3991-4035` block still exists, and must NOT re-read `provider_credentials` directly. Phase 5 consumes P4's normalized seam by name: `{ credentialKind: "company_api_key" | "personal_subscription" | null, executionTargetSlug: string | null }`.

---

## Task 0: gVisor runsc validation spike (GO/NO-GO GATE)

**This is a manual infrastructure spike, not code. Do not start Task 1+ until it passes.** It produces a verified flag set that Task 2's defaults must match.

**Files:**
- Create: `docs/aoa/guides/gvisor-worker-image.md` (records the verified result)

- [ ] **Step 1: Provision + install runsc on a Hetzner box**

Run (on the Hetzner worker):
```bash
# gVisor install (no nested virtualization required)
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc
sudo runsc install     # registers the runsc runtime with dockerd
sudo systemctl restart docker
docker info | grep -A3 Runtimes
```
Expected: `Runtimes:` lists `runsc`. GO/NO-GO checkpoint A: runsc present without KVM/nested virt.

- [ ] **Step 2: Confirm the pinned CLIs run under runsc**

The codebase pins **claude `2.1.x`** and **codex `0.145.x`** (`server/src/services/cli-auth-topology.ts:293-296`). Build a base image with both CLIs + Node, then:
```bash
docker run --rm --runtime=runsc aoa/agent-base:latest claude --version
docker run --rm --runtime=runsc aoa/agent-base:latest codex --version
```
Expected: prints `2.1.x` and `0.145.x`. GO/NO-GO checkpoint B: neither CLI dies on an unimplemented gVisor syscall.

- [ ] **Step 3: Confirm a one-shot run under the FULL hardened flag set**

```bash
docker run --rm --runtime=runsc \
  --user 1000:1000 --cap-drop=ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /home/agent:rw,nosuid,size=256m \
  --memory 2g --memory-swap 2g --cpus 2 --pids-limit 512 --ipc private \
  --network none \
  -e HOME=/home/agent \
  aoa/agent-base:latest bash -lc 'node -e "require(\"fs\").writeFileSync(process.env.HOME+\"/x\",\"ok\");console.log(\"write-ok\")"'
```
Expected: `write-ok` (proves `--read-only` + tmpfs `$HOME` works; the CLI config dir must live on a writable tmpfs/bind, not the read-only root). GO/NO-GO checkpoint C: memory/pids limits don't starve Node.

- [ ] **Step 4: (M7 — HARD DELIVERABLE) Ship the worker-image egress firewall, then prove filtered egress**

`--network none` alone does not solve egress: a pooled run needs the provider API, so operators switch to `bridge`, and **plain `bridge` filters nothing** — the container reaches `169.254.169.254` (cloud metadata), RFC1918, and the control-plane host. `--add-host` being conditional (Task 2) removes ONE route; it is NOT egress filtering. The firewall is therefore a **required worker-image deliverable in THIS phase, not a follow-up**. On the Hetzner worker image, install a host firewall on the container bridge (nftables/iptables on the `DOCKER-USER` chain, or an explicit egress proxy) that:
- **DENY** RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local `169.254.0.0/16` (incl. `169.254.169.254` metadata), and the control-plane CIDR(s);
- **ALLOW** only the provider API hosts + package registries from the allowlist.

```bash
# DOCKER-USER egress lockdown (runs on the worker image, applied at boot)
iptables -I DOCKER-USER -d 169.254.0.0/16 -j DROP
iptables -I DOCKER-USER -d 10.0.0.0/8      -j DROP
iptables -I DOCKER-USER -d 172.16.0.0/12   -j DROP
iptables -I DOCKER-USER -d 192.168.0.0/16  -j DROP
iptables -I DOCKER-USER -d "$AOA_CONTROL_PLANE_CIDR" -j DROP
# (ALLOW provider/registry hosts is done via the egress proxy's allowlist; default-deny otherwise)
```
Then re-run the Step-3 container on the **filtered** `bridge` and assert: `claude -p "say hi"` succeeds (provider egress ALLOWED) AND `curl -sS --max-time 3 http://169.254.169.254/` times out / is refused (metadata DENIED). **GO/NO-GO checkpoint D: metadata + RFC1918 + control-plane are unreachable while the provider API is reachable.** Until this firewall ships, a cloud pool on `bridge` is **unshippable** — the plan makes NO egress-protection claim for `bridge` without it.

- [ ] **Step 5: Record the verified flag set + firewall policy**

Write `docs/aoa/guides/gvisor-worker-image.md` documenting: runsc version, base image contents, the **exact** verified flag set (the one Task 2 encodes as defaults), any syscall gaps found, and the **egress firewall policy** (the `DOCKER-USER` deny rules above + the proxy allowlist of provider API hosts + package registries). State the residual explicitly: *`--network none` is the safe default; `bridge` is permitted ONLY with the firewall applied; the app layer does NOT filter egress — the worker image does.* If checkpoint B fails for an adapter, record "route that adapter to E2B on the pool" as the fallback and proceed.

- [ ] **Step 6: Commit**

```bash
git add docs/aoa/guides/gvisor-worker-image.md
git commit -m "docs(mt-phase5): gVisor runsc spike — verified hardened flag set + egress firewall policy (Task 0 gate)"
```

---

## Task 1: Shared constants + adapter isolation types

**Files:**
- Modify: `packages/shared/src/constants.ts:407-411` (near `ENVIRONMENT_DRIVERS`)
- Modify: `packages/adapter-utils/src/types.ts:52-61`
- Test: `packages/shared/src/execution-target-constants.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/execution-target-constants.test.ts
import { describe, expect, it } from "vitest";
import {
  EXECUTION_TARGET_KINDS,
  EXECUTION_TARGET_TRUST_CLASSES,
  EXECUTION_TARGET_STATUSES,
  ORG_MAX_CONCURRENT_RUNS_DEFAULT,
  ORG_MAX_CONCURRENT_RUNS_MAX,
} from "./constants.js";

describe("execution target constants", () => {
  it("enumerates the beta kinds incl. the inert desktop seam", () => {
    expect(EXECUTION_TARGET_KINDS).toEqual([
      "pooled_gvisor",
      "dedicated_worker",
      "e2b",
      "local_host",
      "desktop",
    ]);
  });
  it("enumerates trust classes and statuses", () => {
    expect(EXECUTION_TARGET_TRUST_CLASSES).toContain("shared_multitenant");
    expect(EXECUTION_TARGET_TRUST_CLASSES).toContain("dedicated_tenant");
    expect(EXECUTION_TARGET_TRUST_CLASSES).toContain("local_trusted");
    expect(EXECUTION_TARGET_STATUSES).toEqual(["active", "draining", "offline", "disabled"]);
  });
  it("sets a light org concurrency default below the max", () => {
    expect(ORG_MAX_CONCURRENT_RUNS_DEFAULT).toBe(8);
    expect(ORG_MAX_CONCURRENT_RUNS_MAX).toBe(200);
    expect(ORG_MAX_CONCURRENT_RUNS_DEFAULT).toBeLessThan(ORG_MAX_CONCURRENT_RUNS_MAX);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/shared test -- execution-target-constants`
Expected: FAIL — `EXECUTION_TARGET_KINDS` is not exported.

- [ ] **Step 3: Add the constants**

```ts
// packages/shared/src/constants.ts  — append near ENVIRONMENT_DRIVERS (~line 411)
export const EXECUTION_TARGET_KINDS = [
  "pooled_gvisor",
  "dedicated_worker",
  "e2b",
  "local_host",
  "desktop",
] as const;
export type ExecutionTargetKind = (typeof EXECUTION_TARGET_KINDS)[number];

export const EXECUTION_TARGET_TRUST_CLASSES = [
  "shared_multitenant",
  "dedicated_tenant",
  "local_trusted",
] as const;
export type ExecutionTargetTrustClass = (typeof EXECUTION_TARGET_TRUST_CLASSES)[number];

export const EXECUTION_TARGET_STATUSES = ["active", "draining", "offline", "disabled"] as const;
export type ExecutionTargetStatus = (typeof EXECUTION_TARGET_STATUSES)[number];

// Per-Organization concurrency clamp — mirrors HEARTBEAT_MAX_CONCURRENT_RUNS_*.
export const ORG_MAX_CONCURRENT_RUNS_DEFAULT = 8;
export const ORG_MAX_CONCURRENT_RUNS_MAX = 200;
```

Also extend the adapter Docker target type (no behavior yet):

```ts
// packages/adapter-utils/src/types.ts — replace AdapterDockerExecutionTarget (:52-61)
export interface AdapterDockerIsolation {
  user?: string | null;                 // --user 1000:1000
  readOnlyRootfs?: boolean;             // --read-only
  tmpfs?: string[];                     // --tmpfs entries
  memory?: string | null;              // --memory + --memory-swap
  cpus?: string | null;                // --cpus
  pidsLimit?: number | null;           // --pids-limit
  capDropAll?: boolean;                // --cap-drop=ALL
  noNewPrivileges?: boolean;           // --security-opt no-new-privileges
  seccompProfile?: string | null;      // --security-opt seccomp=<path>
  ulimitNofile?: number | null;        // --ulimit nofile=N:N
  ipcPrivate?: boolean;                // --ipc private
}

export interface AdapterDockerExecutionTarget {
  type: "sandbox-docker";
  image: string;
  workdir?: string | null;
  shell?: "sh" | "bash" | null;
  network?: "bridge" | "host" | "none" | null;
  remove?: boolean;
  env?: Record<string, string>;
  installCommand?: string | null;
  /** gVisor: emit `--runtime=runsc`. Default undefined = runc (unchanged). */
  runtime?: "runc" | "runsc" | null;
  /** Opt-in hardening. Default undefined = legacy args (back-compat). */
  isolation?: AdapterDockerIsolation | null;
  /** When true AND callback bridge is active, emit `--add-host host-gateway`. */
  allowHostGateway?: boolean;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/shared test -- execution-target-constants`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/execution-target-constants.test.ts packages/adapter-utils/src/types.ts
git commit -m "feat(mt-phase5): execution-target constants + AdapterDockerIsolation type"
```

---

## Task 2: Harden `buildDockerRunArgs` + conditional `--add-host` (pure fn, Windows-safe)

**Files:**
- Modify: `packages/adapter-utils/src/execution-target.ts:149-178` (`buildDockerRunArgs`) and `:161-170` (the `--add-host` block), `:589-599` (pass bridge flag)
- Test: `packages/adapter-utils/src/execution-target-docker.test.ts:48-96` (update exact-array asserts + add hardening cases)

- [ ] **Step 1: Write the failing tests (update exact-array + add hardening)**

Replace the two `buildDockerRunArgs` cases at `:48-96` and add hardening cases. `buildDockerRunArgs` gains a second arg `opts?: { hostGatewayActive?: boolean }`:

```ts
// packages/adapter-utils/src/execution-target-docker.test.ts — describe("buildDockerRunArgs")
describe("buildDockerRunArgs", () => {
  it("legacy profile is unchanged and OMITS --add-host when the bridge is inactive", () => {
    expect(
      buildDockerRunArgs({
        target: { type: "sandbox-docker", image: "node:22", workdir: "/work", network: "none", env: {} },
        localCwd: "C:\\repo",
        command: "node",
        args: ["script.js"],
        env: { A: "1", B: "two words" },
      }),
    ).toEqual([
      "run",
      "--rm",
      "--workdir",
      "/work",
      "--mount",
      "type=bind,source=C:/repo,target=/work",
      "--network",
      "none",
      "--env",
      "A=1",
      "--env",
      "B=two words",
      "node:22",
      "node",
      "script.js",
    ]);
  });

  it("emits --add-host ONLY when the bridge is active AND the target opts in", () => {
    const withGateway = buildDockerRunArgs(
      {
        target: { type: "sandbox-docker", image: "node:22", network: "bridge", allowHostGateway: true, env: {} },
        localCwd: "/repo",
        command: "node",
        args: [],
        env: {},
      },
      { hostGatewayActive: true },
    );
    expect(withGateway).toContain("--add-host");
    expect(withGateway).toContain("host.docker.internal:host-gateway");

    const noOptIn = buildDockerRunArgs(
      {
        target: { type: "sandbox-docker", image: "node:22", network: "bridge", allowHostGateway: false, env: {} },
        localCwd: "/repo",
        command: "node",
        args: [],
        env: {},
      },
      { hostGatewayActive: true },
    );
    expect(noOptIn).not.toContain("--add-host");
  });

  it("emits the full hardened flag set incl. --runtime=runsc when isolation is set", () => {
    const args = buildDockerRunArgs({
      target: {
        type: "sandbox-docker",
        image: "aoa/agent-base:latest",
        workdir: "/workspace",
        network: "none",
        runtime: "runsc",
        env: {},
        isolation: {
          user: "1000:1000",
          capDropAll: true,
          noNewPrivileges: true,
          seccompProfile: "/etc/aoa/seccomp.json",
          readOnlyRootfs: true,
          tmpfs: ["/tmp:rw,noexec,nosuid,size=64m", "/home/agent:rw,nosuid,size=256m"],
          memory: "2g",
          cpus: "2",
          pidsLimit: 512,
          ulimitNofile: 1024,
          ipcPrivate: true,
        },
      },
      localCwd: "/repo",
      command: "claude",
      args: ["-p", "hi"],
      env: {},
    });
    const joined = args.join(" ");
    expect(joined).toContain("--runtime runsc");
    expect(joined).toContain("--user 1000:1000");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges");
    expect(joined).toContain("--security-opt seccomp=/etc/aoa/seccomp.json");
    expect(joined).toContain("--read-only");
    expect(joined).toContain("--tmpfs /tmp:rw,noexec,nosuid,size=64m");
    expect(joined).toContain("--tmpfs /home/agent:rw,nosuid,size=256m");
    expect(joined).toContain("--memory 2g");
    expect(joined).toContain("--memory-swap 2g");
    expect(joined).toContain("--cpus 2");
    expect(joined).toContain("--pids-limit 512");
    expect(joined).toContain("--ulimit nofile=1024:1024");
    expect(joined).toContain("--ipc private");
    expect(joined).toContain("--network none");
    // image + command always last, in order
    expect(args.slice(-3)).toEqual(["aoa/agent-base:latest", "claude", "-p"]);
    expect(args[args.length - 1]).toBe("hi");
  });
});
```

Also update the mocked-`run` sandbox-docker test at `:98-141`: it asserts `expect.arrayContaining([...])` (order-independent) so it still passes, but add one line asserting `--add-host` is now **absent** there (that test starts no bridge). Insert after `:134`:
```ts
    expect(run.mock.calls[0]![2] as string[]).not.toContain("--add-host");
```
And in the bridge test at `:159-186` (which sets `authToken`+`apiBaseUrl`), the target must opt in — change its target literal at `:165` to `{ type: "sandbox-docker", image: "node:22", allowHostGateway: true }` and keep the existing bridge-URL assertions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @armyofagents/adapter-utils test -- execution-target-docker`
Expected: FAIL — old `--add-host` still unconditional; `runtime`/`isolation` flags not emitted; `buildDockerRunArgs` takes one arg.

- [ ] **Step 3: Implement the hardened builder**

```ts
// packages/adapter-utils/src/execution-target.ts — replace buildDockerRunArgs (:149-178)
export function buildDockerRunArgs(
  input: {
    target: AdapterDockerExecutionTarget;
    localCwd: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    stdin?: string;
  },
  opts: { hostGatewayActive?: boolean } = {},
): string[] {
  const workdir = input.target.workdir ?? "/workspace";
  const iso = input.target.isolation ?? null;
  const dockerArgs = ["run"];
  if (input.target.remove !== false) dockerArgs.push("--rm");
  if (input.stdin != null) dockerArgs.push("--interactive");

  // gVisor runtime (opt-in).
  if (input.target.runtime === "runsc") dockerArgs.push("--runtime", "runsc");

  // Isolation profile (opt-in; default undefined = legacy args unchanged).
  if (iso) {
    if (iso.user) dockerArgs.push("--user", iso.user);
    if (iso.capDropAll) dockerArgs.push("--cap-drop", "ALL");
    if (iso.noNewPrivileges) dockerArgs.push("--security-opt", "no-new-privileges");
    if (iso.seccompProfile) dockerArgs.push("--security-opt", `seccomp=${iso.seccompProfile}`);
    if (iso.readOnlyRootfs) dockerArgs.push("--read-only");
    for (const t of iso.tmpfs ?? []) dockerArgs.push("--tmpfs", t);
    if (iso.memory) {
      dockerArgs.push("--memory", iso.memory, "--memory-swap", iso.memory);
    }
    if (iso.cpus) dockerArgs.push("--cpus", iso.cpus);
    if (typeof iso.pidsLimit === "number") dockerArgs.push("--pids-limit", String(iso.pidsLimit));
    if (typeof iso.ulimitNofile === "number") {
      dockerArgs.push("--ulimit", `nofile=${iso.ulimitNofile}:${iso.ulimitNofile}`);
    }
    if (iso.ipcPrivate) dockerArgs.push("--ipc", "private");
  }

  dockerArgs.push(
    "--workdir",
    workdir,
    "--mount",
    `type=bind,source=${formatDockerBindSource(input.localCwd)},target=${workdir}`,
    "--network",
    input.target.network ?? "bridge",
  );

  // SSRF fix: host-gateway is a route to the control-plane host. Only emit it
  // when the callback bridge is actually running AND the target opts in.
  if (opts.hostGatewayActive && input.target.allowHostGateway) {
    dockerArgs.push("--add-host", "host.docker.internal:host-gateway");
  }

  for (const [key, value] of Object.entries(input.env)) {
    dockerArgs.push("--env", `${key}=${value}`);
  }

  dockerArgs.push(input.target.image, input.command, ...input.args);
  return dockerArgs;
}
```

Update the single caller at `:589-599` to pass the bridge flag (the bridge is started just above at `:574-587`, so pass `!!bridge && !!input.target.allowHostGateway` — the builder re-checks opt-in):

```ts
    return await run(
      opts.runId,
      "docker",
      buildDockerRunArgs(
        {
          target,
          localCwd: workspace.localCwd,
          command: commandSpec.command,
          args: commandSpec.args,
          env,
          stdin: opts.stdin,
        },
        { hostGatewayActive: bridge != null },
      ),
      {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @armyofagents/adapter-utils test -- execution-target-docker`
Expected: PASS (all cases, incl. legacy-unchanged and hardened).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-utils/src/execution-target.ts packages/adapter-utils/src/execution-target-docker.test.ts
git commit -m "feat(mt-phase5): harden buildDockerRunArgs (runsc + isolation) + conditional --add-host SSRF fix"
```

---

## Task 3: `resolveAdapterExecutionTarget` parses `runtime` + `isolation` + `allowHostGateway`

**Files:**
- Modify: `packages/adapter-utils/src/execution-target.ts:59-84` (the `sandbox-docker` branch)
- Test: `packages/adapter-utils/src/execution-target-resolve.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/adapter-utils/src/execution-target-resolve.test.ts
import { describe, expect, it } from "vitest";
import { resolveAdapterExecutionTarget } from "./execution-target.js";

describe("resolveAdapterExecutionTarget sandbox-docker hardening", () => {
  it("parses runtime, isolation, and allowHostGateway", () => {
    const t = resolveAdapterExecutionTarget({
      type: "sandbox-docker",
      image: "aoa/agent-base:latest",
      network: "none",
      runtime: "runsc",
      allowHostGateway: false,
      isolation: {
        user: "1000:1000",
        capDropAll: true,
        readOnlyRootfs: true,
        tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"],
        memory: "2g",
        cpus: "2",
        pidsLimit: 512,
        noNewPrivileges: true,
      },
    });
    if (t.type !== "sandbox-docker") throw new Error("expected sandbox-docker");
    expect(t.runtime).toBe("runsc");
    expect(t.allowHostGateway).toBe(false);
    expect(t.isolation?.user).toBe("1000:1000");
    expect(t.isolation?.pidsLimit).toBe(512);
  });

  it("defaults are back-compat: no runtime, no isolation, no host-gateway opt-in", () => {
    const t = resolveAdapterExecutionTarget({ type: "sandbox-docker", image: "node:22" });
    if (t.type !== "sandbox-docker") throw new Error("expected sandbox-docker");
    expect(t.runtime ?? null).toBeNull();
    expect(t.isolation ?? null).toBeNull();
    expect(t.allowHostGateway ?? false).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/adapter-utils test -- execution-target-resolve`
Expected: FAIL — `runtime`/`isolation` are dropped by the resolver.

- [ ] **Step 3: Implement the parse**

```ts
// packages/adapter-utils/src/execution-target.ts — in the sandbox-docker branch, before the return at :74
  const runtimeRaw = asString(config.runtime, "runc");
  const runtime = runtimeRaw === "runsc" ? "runsc" : "runc";
  const isolationRaw = config.isolation && typeof config.isolation === "object" && !Array.isArray(config.isolation)
    ? (config.isolation as Record<string, unknown>)
    : null;
  const isolation = isolationRaw
    ? {
        user: asString(isolationRaw.user, "") || null,
        capDropAll: asBoolean(isolationRaw.capDropAll, false),
        noNewPrivileges: asBoolean(isolationRaw.noNewPrivileges, false),
        seccompProfile: asString(isolationRaw.seccompProfile, "") || null,
        readOnlyRootfs: asBoolean(isolationRaw.readOnlyRootfs, false),
        tmpfs: Array.isArray(isolationRaw.tmpfs)
          ? isolationRaw.tmpfs.filter((v): v is string => typeof v === "string")
          : [],
        memory: asString(isolationRaw.memory, "") || null,
        cpus: asString(isolationRaw.cpus, "") || null,
        pidsLimit: typeof isolationRaw.pidsLimit === "number" ? isolationRaw.pidsLimit : null,
        ulimitNofile: typeof isolationRaw.ulimitNofile === "number" ? isolationRaw.ulimitNofile : null,
        ipcPrivate: asBoolean(isolationRaw.ipcPrivate, false),
      }
    : null;
```

Then include them in the returned object (`:74-83`):
```ts
  return {
    type: "sandbox-docker",
    image,
    workdir: asString(config.workdir, "/workspace"),
    shell: shell === "bash" ? "bash" : "sh",
    network: network === "host" || network === "none" ? network : "bridge",
    remove: asBoolean(config.remove, true),
    env,
    installCommand: asString(config.installCommand, "") || null,
    runtime,
    isolation,
    allowHostGateway: asBoolean(config.allowHostGateway, false),
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/adapter-utils test -- execution-target-resolve`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-utils/src/execution-target.ts packages/adapter-utils/src/execution-target-resolve.test.ts
git commit -m "feat(mt-phase5): resolveAdapterExecutionTarget parses runtime + isolation + allowHostGateway"
```

---

## Task 4: `execution_targets` Drizzle schema + barrel export + migration + seed

**Files:**
- Create: `packages/db/src/schema/execution_targets.ts`
- Modify: `packages/db/src/schema/index.ts:135` (add export)
- Test: `packages/db/src/schema/execution-targets-schema.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/schema/execution-targets-schema.test.ts
import { describe, expect, it } from "vitest";
import { executionTargets } from "./execution_targets.js";
import { getTableConfig } from "drizzle-orm/pg-core";

describe("execution_targets schema", () => {
  it("is tenant-scoped with a nullable organization_id FK and required slug/kind", () => {
    const cfg = getTableConfig(executionTargets);
    expect(cfg.name).toBe("execution_targets");
    const col = (n: string) => cfg.columns.find((c) => c.name === n)!;
    expect(col("organization_id").notNull).toBe(false); // nullable = system/shared rows
    expect(col("owner_user_id").notNull).toBe(false);
    expect(col("slug").notNull).toBe(true);
    expect(col("kind").notNull).toBe(true);
    expect(col("trust_class").notNull).toBe(true);
    expect(col("status").notNull).toBe(true);
    expect(col("last_seen_at").notNull).toBe(false);
  });
  it("has an (organization_id, slug) unique constraint with NULLS NOT DISTINCT (idempotent system seed)", () => {
    const cfg = getTableConfig(executionTargets);
    const uq = cfg.uniqueConstraints.find((c) => c.name === "execution_targets_org_slug_uq")!;
    expect(uq.columns.map((c) => (c as { name: string }).name)).toEqual(["organization_id", "slug"]);
    // NULLS NOT DISTINCT lets (NULL, "control-plane") collide so the boot seed is idempotent.
    expect((uq as { nullsNotDistinct?: boolean }).nullsNotDistinct).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/db test -- execution-targets-schema`
Expected: FAIL — module `./execution_targets.js` not found.

- [ ] **Step 3: Create the schema + export**

```ts
// packages/db/src/schema/execution_targets.ts
import { pgTable, uuid, text, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { organizations } from "./organizations.js"; // P1 (0188) — merged before P5

/**
 * Tenant-scoped execution-target registry (fleet inventory).
 *
 * P1 is merged first, so organizationId is a real FK now (M6-FK). It stays
 * NULLABLE: NULL organizationId = a system/shared target (the pooled gVisor row
 * and the seeded control-plane). ON DELETE SET NULL — a deleted org's dedicated
 * targets survive as orphaned/system rows rather than cascading away mid-run
 * (an operator reclaims or disables them). `slug` matches the
 * AOA_EXECUTION_TARGET_ID string that provider_credentials rows bind to.
 */
export const executionTargets = pgTable(
  "execution_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }), // nullable = system/shared
    ownerUserId: text("owner_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    slug: text("slug").notNull(),
    kind: text("kind").notNull(), // pooled_gvisor | dedicated_worker | e2b | local_host | desktop
    trustClass: text("trust_class").notNull(), // shared_multitenant | dedicated_tenant | local_trusted
    status: text("status").notNull().default("active"), // active | draining | offline | disabled
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // M5: system rows have organization_id = NULL. Default NULLS DISTINCT would
    // let every NULL-org slug collide-never, so the control-plane seed and any
    // org-null pooled_gvisor row would DUPLICATE on every boot. NULLS NOT
    // DISTINCT (PG15+) makes NULL == NULL so (NULL, "control-plane") is unique
    // and onConflictDoNothing matches. Mirrors provider_quota_windows.ts:48-55.
    orgSlugUq: unique("execution_targets_org_slug_uq")
      .on(table.organizationId, table.slug)
      .nullsNotDistinct(),
    kindStatusIdx: index("execution_targets_kind_status_idx").on(table.kind, table.status),
    orgIdx: index("execution_targets_org_idx").on(table.organizationId),
  }),
);
```

```ts
// packages/db/src/schema/index.ts — add near :135 (environments export)
export { executionTargets } from "./execution_targets.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/db test -- execution-targets-schema`
Expected: PASS

- [ ] **Step 5: Generate migration + seed the control-plane row**

Run: `pnpm db:generate` (produces `packages/db/src/migrations/0191_*.sql` + updated `meta/_journal.json` + `meta/0191_snapshot.json` — assumes P1-P4 already took 0188-0190).

The **concrete seed site** is the boot sequence in `server/src/index.ts` (~`:568-575`, immediately after `initializeBoardClaimChallenge` / alongside `backfillWorkQuestionSnapshots(db)` — this is exactly where P1's `ensureDefaultOrganization(db)` will be invoked at boot). Create the idempotent helper in `server/src/services/execution-targets.ts` and call it there:

```ts
// server/src/services/execution-targets.ts
// M5: idempotent only because execution_targets_org_slug_uq is NULLS NOT DISTINCT
// (Task 4). With default NULLS DISTINCT this onConflict target would never match a
// system row (organization_id = NULL) and would insert a duplicate every boot.
export async function ensureControlPlaneExecutionTarget(db: Db): Promise<void> {
  await db.insert(executionTargets).values({
    organizationId: null,
    slug: "control-plane",
    kind: "local_host",
    trustClass: "local_trusted",
    status: "active",
    capabilities: { runtimes: ["runc"], adapters: ["claude_local", "codex_local", "process"] },
    config: { transport: "local_host" },
  }).onConflictDoNothing({ target: [executionTargets.organizationId, executionTargets.slug] });
}
```

```ts
// server/src/index.ts — after the backfillWorkQuestionSnapshots(db) call (~:572)
const { ensureControlPlaneExecutionTarget } = await import("./services/execution-targets.js");
await ensureControlPlaneExecutionTarget(db as any);
```

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/execution_targets.ts packages/db/src/schema/index.ts packages/db/src/schema/execution-targets-schema.test.ts packages/db/src/migrations server/src/services/execution-targets.ts server/src/index.ts
git commit -m "feat(mt-phase5): execution_targets registry schema + migration 0191 + control-plane boot seed"
```

---

## Task 5: `environments.execution_target_id` FK + validators (gvisor config + executionTargetId)

**Files:**
- Modify: `packages/db/src/schema/environments.ts:17`
- Modify: `packages/shared/src/validators/environment.ts:16-89`
- Create: `packages/shared/src/validators/execution-target.ts`
- Test: `packages/shared/src/validators/environment-gvisor.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/validators/environment-gvisor.test.ts
import { describe, expect, it } from "vitest";
import { createEnvironmentSchema } from "./environment.js";

describe("gvisor environment config + executionTargetId", () => {
  it("accepts a gvisor sandbox environment with an isolation profile", () => {
    const parsed = createEnvironmentSchema.safeParse({
      name: "pool",
      driver: "sandbox",
      config: {
        provider: "gvisor",
        image: "aoa/agent-base:latest",
        runtime: "runsc",
        network: "none",
        isolation: { user: "1000:1000", capDropAll: true, readOnlyRootfs: true, memory: "2g", cpus: "2", pidsLimit: 512 },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a gvisor config missing an image", () => {
    const parsed = createEnvironmentSchema.safeParse({
      name: "pool",
      driver: "sandbox",
      config: { provider: "gvisor", runtime: "runsc" },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts an environment pinned to an executionTargetId", () => {
    const parsed = createEnvironmentSchema.safeParse({
      name: "pinned",
      driver: "sandbox",
      config: { provider: "gvisor", image: "aoa/agent-base:latest" },
      executionTargetId: "11111111-1111-1111-1111-111111111111",
    });
    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/shared test -- environment-gvisor`
Expected: FAIL — no `gvisor` schema, `executionTargetId` unknown key rejected.

- [ ] **Step 3: Implement schema + validators**

```ts
// packages/db/src/schema/environments.ts — add after target (:17)
    executionTargetId: uuid("execution_target_id").references(() => executionTargets.id, { onDelete: "set null" }),
```
Add the import at top: `import { executionTargets } from "./execution_targets.js";`

```ts
// packages/shared/src/validators/execution-target.ts
import { z } from "zod";
import { EXECUTION_TARGET_KINDS, EXECUTION_TARGET_TRUST_CLASSES, EXECUTION_TARGET_STATUSES } from "../constants.js";

export const dockerIsolationSchema = z.object({
  user: z.string().optional().nullable(),
  capDropAll: z.boolean().optional(),
  noNewPrivileges: z.boolean().optional(),
  seccompProfile: z.string().optional().nullable(),
  readOnlyRootfs: z.boolean().optional(),
  tmpfs: z.array(z.string()).optional(),
  memory: z.string().optional().nullable(),
  cpus: z.string().optional().nullable(),
  pidsLimit: z.number().int().positive().max(100000).optional().nullable(),
  ulimitNofile: z.number().int().positive().max(1048576).optional().nullable(),
  ipcPrivate: z.boolean().optional(),
}).strict();

export const gvisorEnvironmentConfigSchema = z.object({
  provider: z.literal("gvisor"),
  image: z.string().min(1),
  runtime: z.enum(["runc", "runsc"]).optional().default("runsc"),
  network: z.enum(["bridge", "host", "none"]).optional().default("none"),
  workdir: z.string().min(1).optional(),
  shell: z.enum(["sh", "bash"]).optional(),
  installCommand: z.string().optional().nullable(),
  allowHostGateway: z.boolean().optional().default(false),
  isolation: dockerIsolationSchema.optional(),
}).strict();

export const createExecutionTargetSchema = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(EXECUTION_TARGET_KINDS),
  trustClass: z.enum(EXECUTION_TARGET_TRUST_CLASSES),
  status: z.enum(EXECUTION_TARGET_STATUSES).optional().default("active"),
  ownerUserId: z.string().optional().nullable(),
  capabilities: z.record(z.unknown()).optional().default({}),
  config: z.record(z.unknown()).optional().default({}),
});
export type CreateExecutionTargetInput = z.infer<typeof createExecutionTargetSchema>;
```

```ts
// packages/shared/src/validators/environment.ts — extend rejectInvalidProviderConfig (:41-60)
// after the e2b branch, add:
  if (config.provider === "gvisor") {
    const parsed = gvisorEnvironmentConfigSchema.safeParse(config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["config", ...issue.path], message: issue.message });
      }
    }
  }
```
Import at top: `import { gvisorEnvironmentConfigSchema } from "./execution-target.js";`
And add `executionTargetId: z.string().uuid().optional().nullable(),` to both `createEnvironmentSchema` (:62-72) and `updateEnvironmentSchema` (:74-84).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/shared test -- environment-gvisor`
Expected: PASS. Then `pnpm db:generate` for the `execution_target_id` column migration (`packages/db/src/migrations/0192_*.sql`; or fold into `0191` if generated in the same pass as Task 4).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/environments.ts packages/shared/src/validators/environment.ts packages/shared/src/validators/execution-target.ts packages/shared/src/validators/environment-gvisor.test.ts packages/db/src/migrations
git commit -m "feat(mt-phase5): environments.execution_target_id FK (migration 0192) + gvisor config + executionTarget validators"
```

---

## Task 6: gVisor config resolution in `environment-runtime.ts` (`sandbox` driver branch)

**Files:**
- Modify: `server/src/services/environment-runtime.ts:182-201` (`resolveDockerSandboxConfig` / `isDockerSandboxProvider`)
- Test: `server/src/__tests__/gvisor-sandbox-config.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/gvisor-sandbox-config.test.ts
import { describe, expect, it } from "vitest";
import { resolveGvisorSandboxTarget } from "../services/environment-runtime.js";

describe("resolveGvisorSandboxTarget", () => {
  it("maps a gvisor environment config to a hardened sandbox-docker target", () => {
    const target = resolveGvisorSandboxTarget({
      provider: "gvisor",
      image: "aoa/agent-base:latest",
      isolation: { user: "1000:1000", capDropAll: true, readOnlyRootfs: true, memory: "2g", cpus: "2", pidsLimit: 512 },
    });
    expect(target.type).toBe("sandbox-docker");
    expect(target.runtime).toBe("runsc");
    expect(target.network).toBe("none");            // egress default
    expect(target.allowHostGateway).toBe(false);
    expect(target.isolation?.user).toBe("1000:1000");
    expect(target.isolation?.noNewPrivileges).toBe(true); // default-on for gvisor
    expect(target.isolation?.tmpfs?.length).toBeGreaterThan(0);
  });
  it("throws when a gvisor config has no image", () => {
    expect(() => resolveGvisorSandboxTarget({ provider: "gvisor" })).toThrow(/image/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- gvisor-sandbox-config`
Expected: FAIL — `resolveGvisorSandboxTarget` not exported.

- [ ] **Step 3: Implement**

```ts
// server/src/services/environment-runtime.ts — add export near resolveDockerSandboxConfig (:182)
export function resolveGvisorSandboxTarget(config: Record<string, unknown>): {
  type: "sandbox-docker";
  image: string;
  workdir: string;
  network: "none" | "bridge" | "host";
  runtime: "runsc";
  allowHostGateway: boolean;
  isolation: Record<string, unknown>;
} {
  const image = readString(config.image);
  if (!image) throw new Error("gVisor environments require config.image.");
  const iso = (config.isolation && typeof config.isolation === "object" && !Array.isArray(config.isolation)
    ? (config.isolation as Record<string, unknown>)
    : {});
  const networkRaw = readString(config.network) ?? "none";
  return {
    type: "sandbox-docker",
    image,
    workdir: readString(config.workdir) ?? "/workspace",
    network: networkRaw === "bridge" || networkRaw === "host" ? networkRaw : "none",
    runtime: "runsc",
    allowHostGateway: config.allowHostGateway === true,
    isolation: {
      user: readString(iso.user) ?? "1000:1000",
      capDropAll: iso.capDropAll !== false,
      noNewPrivileges: iso.noNewPrivileges !== false,
      seccompProfile: readString(iso.seccompProfile),
      readOnlyRootfs: iso.readOnlyRootfs !== false,
      tmpfs: Array.isArray(iso.tmpfs) && iso.tmpfs.length > 0
        ? iso.tmpfs
        : ["/tmp:rw,noexec,nosuid,size=64m", "/home/agent:rw,nosuid,size=256m"],
      memory: readString(iso.memory) ?? "2g",
      cpus: readString(iso.cpus) ?? "2",
      pidsLimit: typeof iso.pidsLimit === "number" ? iso.pidsLimit : 512,
      ipcPrivate: iso.ipcPrivate !== false,
    },
  };
}
```
Also add `"gvisor"` to the recognized providers so `isDockerSandboxProvider` (:199-201) treats it as a local-docker sandbox (single-box beta transport):
```ts
function isDockerSandboxProvider(provider: string): boolean {
  return provider === "sandbox-docker" || provider === "docker" || provider === "local-docker" || provider === "gvisor";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- gvisor-sandbox-config`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/environment-runtime.ts server/src/__tests__/gvisor-sandbox-config.test.ts
git commit -m "feat(mt-phase5): resolveGvisorSandboxTarget — gVisor maps to hardened sandbox-docker on single-box transport"
```

---

## Task 7: Register a `gvisor` SandboxRuntimeProvider (pool transport seam)

**Files:**
- Create: `server/src/services/gvisor-sandbox-provider.ts`
- Modify: `server/src/services/sandbox-provider-runtime.ts:531-541` (register alongside e2b)
- Test: `server/src/__tests__/gvisor-sandbox-provider.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/gvisor-sandbox-provider.test.ts
import { describe, expect, it, vi } from "vitest";
import { createGvisorSandboxRuntimeProvider } from "../services/gvisor-sandbox-provider.js";

describe("gvisor sandbox runtime provider", () => {
  it("validateConfig requires an image and a pool endpoint for remote transport", async () => {
    const p = createGvisorSandboxRuntimeProvider();
    const bad = await p.validateConfig!({ provider: "gvisor", transport: "pool" });
    expect(bad.ok).toBe(false);
    const ok = await p.validateConfig!({ provider: "gvisor", transport: "pool", image: "aoa/agent-base:latest", poolEndpoint: "https://pool.internal" });
    expect(ok.ok).toBe(true);
  });

  it("delegates execute to the injected pool client", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "hi", stderr: "" });
    const p = createGvisorSandboxRuntimeProvider({ poolClient: { acquire: vi.fn().mockResolvedValue({ providerLeaseId: "lease-1", metadata: {} }), release: vi.fn().mockResolvedValue({ cleanupStatus: "success" }), run } });
    const res = await p.execute({ providerLeaseId: "lease-1", leaseMetadata: {}, command: "claude", args: ["-p", "hi"] });
    expect(run).toHaveBeenCalled();
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hi");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- gvisor-sandbox-provider`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the provider (mirrors e2b's injection seam)**

```ts
// server/src/services/gvisor-sandbox-provider.ts
import type {
  SandboxRuntimeProvider,
  SandboxProviderAcquireInput,
  SandboxProviderReleaseInput,
  SandboxProviderExecuteInput,
} from "./sandbox-provider-runtime.js";

export interface GvisorPoolClient {
  acquire(input: SandboxProviderAcquireInput): Promise<{ providerLeaseId: string; expiresAt?: Date | null; metadata: Record<string, unknown> }>;
  release(input: SandboxProviderReleaseInput): Promise<{ cleanupStatus: "success" | "failed"; metadata?: Record<string, unknown> }>;
  run(input: SandboxProviderExecuteInput): Promise<{ exitCode: number | null; stdout: string; stderr: string; signal?: string | null; timedOut?: boolean }>;
}

function readString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function createGvisorSandboxRuntimeProvider(
  options: { poolClient?: GvisorPoolClient } = {},
): SandboxRuntimeProvider {
  const pool = options.poolClient;
  function requirePool(): GvisorPoolClient {
    if (!pool) throw new Error("gVisor pool transport is not configured (no poolClient). Single-box beta uses the local sandbox-docker path instead.");
    return pool;
  }
  return {
    provider: "gvisor",
    async validateConfig(config) {
      const errors: string[] = [];
      if (!readString(config.image)) errors.push("gVisor environments require config.image.");
      if (config.transport === "pool" && !readString(config.poolEndpoint)) {
        errors.push("gVisor pool transport requires config.poolEndpoint.");
      }
      return { ok: errors.length === 0, provider: "gvisor", ...(errors.length ? { errors } : {}), sanitizedConfig: { provider: "gvisor", transport: config.transport ?? "local_docker", hasImage: Boolean(readString(config.image)) } };
    },
    async probe(input) {
      const v = await this.validateConfig!(input.config);
      return { ok: v.ok, provider: "gvisor", summary: v.ok ? "gVisor pool configuration is valid." : "gVisor pool configuration is invalid.", ...(v.errors ? { errors: v.errors } : {}) };
    },
    async acquireLease(input) {
      const lease = await requirePool().acquire(input);
      return { providerLeaseId: lease.providerLeaseId, expiresAt: lease.expiresAt ?? null, metadata: { provider: "gvisor", ...lease.metadata } };
    },
    async releaseLease(input) {
      return requirePool().release(input);
    },
    async execute(input) {
      const r = await requirePool().run(input);
      return { exitCode: r.exitCode, signal: r.signal ?? null, timedOut: r.timedOut ?? false, stdout: r.stdout, stderr: r.stderr };
    },
  };
}
```

Register it (peer to e2b) in `sandbox-provider-runtime.ts` `sandboxProviderRuntime` default list (:537-541):
```ts
  for (const provider of options.providers ?? [
    createFakeSandboxRuntimeProvider(),
    createE2bSandboxRuntimeProvider(),
    createGvisorSandboxRuntimeProvider(),
  ]) {
```
Add the import at top of `sandbox-provider-runtime.ts`:
```ts
import { createGvisorSandboxRuntimeProvider } from "./gvisor-sandbox-provider.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- gvisor-sandbox-provider`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/gvisor-sandbox-provider.ts server/src/services/sandbox-provider-runtime.ts server/src/__tests__/gvisor-sandbox-provider.test.ts
git commit -m "feat(mt-phase5): register gvisor SandboxRuntimeProvider (pool transport seam, injectable pool client)"
```

---

## Task 8: `execution-target-resolver` — route by credential kind

**Files:**
- Create: `server/src/services/execution-target-resolver.ts`
- Test: `server/src/__tests__/execution-target-resolver.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/execution-target-resolver.test.ts
import { describe, expect, it } from "vitest";
import { chooseExecutionTargetRow } from "../services/execution-target-resolver.js";

const pooled = { id: "t-pool", slug: "pool-1", kind: "pooled_gvisor", trustClass: "shared_multitenant", status: "active", organizationId: null };
const dedicated = { id: "t-ded", slug: "hetzner-owner", kind: "dedicated_worker", trustClass: "dedicated_tenant", status: "active", organizationId: "org-1" };

// credentialKind + executionTargetSlug are P4's normalized seam fields (verbatim).
describe("chooseExecutionTargetRow (route by credential kind)", () => {
  it("business key routes to the org pooled_gvisor target", () => {
    const chosen = chooseExecutionTargetRow({ credentialKind: "company_api_key", pinnedTargetId: null, executionTargetSlug: null, targets: [pooled, dedicated] });
    expect(chosen.id).toBe("t-pool");
  });
  it("personal subscription routes to the dedicated target whose slug matches the credential", () => {
    const chosen = chooseExecutionTargetRow({ credentialKind: "personal_subscription", pinnedTargetId: null, executionTargetSlug: "hetzner-owner", targets: [pooled, dedicated] });
    expect(chosen.id).toBe("t-ded");
  });
  it("fails closed when a personal subscription's target does not match any dedicated target", () => {
    expect(() => chooseExecutionTargetRow({ credentialKind: "personal_subscription", pinnedTargetId: null, executionTargetSlug: "ghost", targets: [pooled, dedicated] })).toThrow(/target/i);
  });
  it("honors an explicit environment pin", () => {
    const chosen = chooseExecutionTargetRow({ credentialKind: "company_api_key", pinnedTargetId: "t-ded", executionTargetSlug: null, targets: [pooled, dedicated] });
    expect(chosen.id).toBe("t-ded");
  });
  it("returns null (fallback to local) when no targets exist", () => {
    const chosen = chooseExecutionTargetRow({ credentialKind: "company_api_key", pinnedTargetId: null, executionTargetSlug: null, targets: [] });
    expect(chosen).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- execution-target-resolver`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure chooser + the DB-backed resolver**

```ts
// server/src/services/execution-target-resolver.ts
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { executionTargets } from "@armyofagents/db";

export interface ExecutionTargetRow {
  id: string;
  slug: string;
  kind: string;
  trustClass: string;
  status: string;
  organizationId: string | null;
  config?: Record<string, unknown>;
}

// `credentialKind` + `executionTargetSlug` are P4's normalized seam field names.
export function chooseExecutionTargetRow(input: {
  credentialKind: "company_api_key" | "personal_subscription" | null;
  pinnedTargetId: string | null;
  executionTargetSlug: string | null;
  targets: ExecutionTargetRow[];
}): ExecutionTargetRow | null {
  const active = input.targets.filter((t) => t.status === "active");
  if (input.pinnedTargetId) {
    const pinned = active.find((t) => t.id === input.pinnedTargetId);
    if (!pinned) throw new Error(`Pinned execution target ${input.pinnedTargetId} is not available.`);
    if (input.credentialKind === "personal_subscription" && input.executionTargetSlug && pinned.slug !== input.executionTargetSlug) {
      throw new Error("Pinned target does not match the subscription credential's execution target.");
    }
    return pinned;
  }
  if (input.credentialKind === "personal_subscription") {
    if (!input.executionTargetSlug) throw new Error("Personal subscription run has no bound execution target.");
    const match = active.find((t) => t.slug === input.executionTargetSlug && (t.kind === "dedicated_worker" || t.kind === "local_host"));
    if (!match) throw new Error(`No dedicated execution target matches credential target "${input.executionTargetSlug}".`);
    return match;
  }
  // company_api_key (business key) -> shared pool
  const pool = active.find((t) => t.kind === "pooled_gvisor");
  return pool ?? null; // null => caller falls back to local (self-hosted single tenant)
}

export async function resolveExecutionTargetForRun(
  db: Db,
  input: {
    organizationId: string | null;
    companyId: string;
    // credentialKind + executionTargetSlug come straight off P4's resolver seam.
    credentialKind: "company_api_key" | "personal_subscription" | null;
    pinnedTargetId: string | null;
    executionTargetSlug: string | null;
  },
): Promise<ExecutionTargetRow | null> {
  // System/shared targets (organizationId null) + this org's targets are both eligible.
  const rows = (await db
    .select({
      id: executionTargets.id,
      slug: executionTargets.slug,
      kind: executionTargets.kind,
      trustClass: executionTargets.trustClass,
      status: executionTargets.status,
      organizationId: executionTargets.organizationId,
      config: executionTargets.config,
    })
    .from(executionTargets)) as ExecutionTargetRow[];
  const scoped = rows.filter((t) => t.organizationId == null || t.organizationId === input.organizationId);
  return chooseExecutionTargetRow({
    credentialKind: input.credentialKind,
    pinnedTargetId: input.pinnedTargetId,
    executionTargetSlug: input.executionTargetSlug,
    targets: scoped,
  });
}

export function executionTargetToAdapterConfig(target: ExecutionTargetRow): Record<string, unknown> | null {
  const cfg = target.config ?? {};
  if (target.kind === "local_host") return null; // local driver, no override
  if (target.kind === "pooled_gvisor" || target.kind === "dedicated_worker") {
    // Single-box beta: emit a hardened sandbox-docker config the local docker path runs.
    return {
      type: "sandbox-docker",
      image: (cfg.image as string) ?? "aoa/agent-base:latest",
      runtime: "runsc",
      network: (cfg.network as string) ?? "none",
      allowHostGateway: cfg.allowHostGateway === true,
      isolation: cfg.isolation ?? { user: "1000:1000", capDropAll: true, noNewPrivileges: true, readOnlyRootfs: true, tmpfs: ["/tmp:rw,noexec,nosuid,size=64m", "/home/agent:rw,nosuid,size=256m"], memory: "2g", cpus: "2", pidsLimit: 512, ipcPrivate: true },
    };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- execution-target-resolver`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/execution-target-resolver.ts server/src/__tests__/execution-target-resolver.test.ts
git commit -m "feat(mt-phase5): execution-target-resolver — route by credential kind (business key -> pool, personal -> dedicated)"
```

---

## Task 9: Wire the resolver into heartbeat (P4-FIRST — build on the post-delete block)

> **CROSS-PHASE — DO THIS AFTER P4.** `heartbeat.ts:2946-4035` is jointly owned and executed P4-first. P4 Task 12(b) **deletes** the `:3991-4035` subscription block and folds the subscription-home logic into a `legacySubscriptionEnv` closure (the old dedicated-target throw now lives inside that closure's `local` branch — Phase 5 does NOT re-add or relocate it). Phase 5 only *adds* the target-routing call after `applyEnvironmentRuntimeTarget`, and consumes P4's normalized seam `{ credentialKind, executionTargetSlug }`. Do not read `provider_credentials`/`agent_provider_credential_bindings` here — P4 already resolved them.

**Files:**
- Modify: `server/src/services/heartbeat.ts` — insert the routing call after `applyEnvironmentRuntimeTarget` (P4's block currently at ~`:2975-2978`; re-anchor on that call, not a line number, since P4 shifts line numbers)
- Modify: `server/src/services/environment-resolver.ts:42-52` (surface `executionTargetId`)
- Test: `server/src/__tests__/heartbeat-execution-target-routing.test.ts` (create — pure helper extracted from heartbeat)

The `heartbeat.ts` wiring is a large-file edit; to keep it testable, extract a pure helper and unit-test that, then wire the call.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/heartbeat-execution-target-routing.test.ts
import { describe, expect, it } from "vitest";
import { mergeResolvedExecutionTarget } from "../services/heartbeat-execution-target.js";

describe("mergeResolvedExecutionTarget", () => {
  it("overrides config.executionTarget when a routed target maps to an adapter config", () => {
    const merged = mergeResolvedExecutionTarget({ env: { X: "1" } }, {
      type: "sandbox-docker", image: "aoa/agent-base:latest", runtime: "runsc", network: "none", isolation: {},
    });
    expect((merged.executionTarget as Record<string, unknown>).runtime).toBe("runsc");
    expect(merged.env).toEqual({ X: "1" });
  });
  it("leaves config untouched when routed target is null (local fallback)", () => {
    const cfg = { env: {}, executionTarget: { type: "local" } };
    expect(mergeResolvedExecutionTarget(cfg, null)).toBe(cfg);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- heartbeat-execution-target-routing`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper + wire heartbeat**

```ts
// server/src/services/heartbeat-execution-target.ts
export function mergeResolvedExecutionTarget(
  config: Record<string, unknown>,
  adapterConfig: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!adapterConfig) return config;
  return { ...config, executionTarget: adapterConfig };
}
```

Wire into `heartbeat.ts` right after the `applyEnvironmentRuntimeTarget` call (P4's block, ~`:2975-2978`). Read the P4 seam by its **exact name**: after P4 Task 12(b), the run scope holds `const p4CredentialHint = toExecutionTargetHint(hbResolved)` exposing `{ credentialKind, executionTargetSlug }`. Consume `p4CredentialHint` directly — do NOT re-query `provider_credentials`/`agent_provider_credential_bindings`. `companies.organization_id` exists (P1 merged first); read it off the agent/company scope:

```ts
// server/src/services/heartbeat.ts — immediately after mergedConfigWithEnvironmentTarget
    const routedTarget = await resolveExecutionTargetForRun(db, {
      organizationId: (agent as { organizationId?: string | null }).organizationId ?? null,
      companyId: agent.companyId,
      // P4 seam (Task 12(b)): `p4CredentialHint = toExecutionTargetHint(hbResolved)`.
      credentialKind: p4CredentialHint.credentialKind,          // "company_api_key" | "personal_subscription" | null
      executionTargetSlug: p4CredentialHint.executionTargetSlug, // bound target slug (null for business keys)
      pinnedTargetId: environmentRuntime.executionTargetId ?? null,
    }).catch(() => null);
    const mergedConfigRouted = mergeResolvedExecutionTarget(
      mergedConfigWithEnvironmentTarget,
      routedTarget ? executionTargetToAdapterConfig(routedTarget) : null,
    );
```

Then feed `mergedConfigRouted` (not `mergedConfigWithEnvironmentTarget`) into everything downstream. Add the imports (`resolveExecutionTargetForRun`, `executionTargetToAdapterConfig`, `mergeResolvedExecutionTarget`) and extend `resolveEnvironmentRuntimeConfig` to surface `executionTargetId` (add `executionTargetId: environments.executionTargetId` to the select at `environment-resolver.ts:42` and to `ResolvedEnvironmentRuntimeConfig`).

**The old throw is P4's, not Phase 5's.** After P4 Task 12(b) the `:3991-4035` block no longer exists; the "Governed subscription credentials require the dedicated local execution target" throw lives inside P4's `legacySubscriptionEnv` closure's `local` branch. Phase 5 does NOT touch that closure — routing a `personal_subscription` run to its dedicated target is handled entirely by `resolveExecutionTargetForRun` above (which fails closed on a slug mismatch), and P4's closure only runs for the `local`/control-plane path. If a routed dedicated target and P4's `local` legacy path ever conflict, P4 owns the reconciliation (its closure is the single subscription-home authority); Phase 5 just supplies the routed `executionTarget` config.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- heartbeat-execution-target-routing`
Then: `pnpm --filter @armyofagents/server test -- heartbeat-env-injection` (regression — env merge unchanged).
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/heartbeat-execution-target.ts server/src/services/heartbeat.ts server/src/services/environment-resolver.ts server/src/__tests__/heartbeat-execution-target-routing.test.ts
git commit -m "feat(mt-phase5): route heartbeat runs to execution target by P4 credential seam"
```

---

## Task 10: Per-Organization concurrency cap

**Files:**
- Create: `server/src/services/org-concurrency.ts`
- Modify: `server/src/services/heartbeat.ts:2496-2503` (gate in `startNextQueuedRunForAgent`)
- Test: `server/src/__tests__/org-concurrency.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/org-concurrency.test.ts
import { describe, expect, it } from "vitest";
import { orgAvailableSlots, normalizeOrgConcurrencyCap } from "../services/org-concurrency.js";
import { ORG_MAX_CONCURRENT_RUNS_DEFAULT, ORG_MAX_CONCURRENT_RUNS_MAX } from "@armyofagents/shared";

describe("org concurrency clamp", () => {
  it("clamps the cap into [1, MAX] and defaults on garbage", () => {
    expect(normalizeOrgConcurrencyCap(null)).toBe(ORG_MAX_CONCURRENT_RUNS_DEFAULT);
    expect(normalizeOrgConcurrencyCap(0)).toBe(1);
    expect(normalizeOrgConcurrencyCap(99999)).toBe(ORG_MAX_CONCURRENT_RUNS_MAX);
    expect(normalizeOrgConcurrencyCap(12)).toBe(12);
  });
  it("computes available slots like the heartbeat per-agent clamp", () => {
    expect(orgAvailableSlots({ cap: 8, running: 3 })).toBe(5);
    expect(orgAvailableSlots({ cap: 8, running: 8 })).toBe(0);
    expect(orgAvailableSlots({ cap: 8, running: 20 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- org-concurrency`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (mirror `normalizeMaxConcurrentRuns` + `countRunningRunsForAgent`)**

```ts
// server/src/services/org-concurrency.ts
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companies, heartbeatRuns } from "@armyofagents/db";
import { ORG_MAX_CONCURRENT_RUNS_DEFAULT, ORG_MAX_CONCURRENT_RUNS_MAX } from "@armyofagents/shared";

export function normalizeOrgConcurrencyCap(value: unknown): number {
  const parsed = Math.floor(typeof value === "number" ? value : Number(value));
  if (!Number.isFinite(parsed)) return ORG_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(1, Math.min(ORG_MAX_CONCURRENT_RUNS_MAX, parsed));
}

export function orgAvailableSlots(input: { cap: number; running: number }): number {
  return Math.max(0, input.cap - input.running);
}

/** Count running heartbeat runs across every company in the organization. */
export async function countRunningRunsForOrg(db: Db, organizationId: string): Promise<number> {
  const companyRows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq((companies as { organizationId: typeof companies.id }).organizationId, organizationId));
  const ids = companyRows.map((r) => r.id);
  if (ids.length === 0) return 0;
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns)
    .where(and(inArray(heartbeatRuns.companyId, ids), eq(heartbeatRuns.status, "running")));
  return Number(count ?? 0);
}
```
> NOTE: `companies.organization_id` + `organizations.concurrency_cap` exist (P1 merged first). `countRunningRunsForOrg` joins on the real column; the gate still guards on a non-null org id so single-tenant/self-hosted companies with no org stay unclamped.

Gate in `startNextQueuedRunForAgent` (:2500-2503), after the per-agent `availableSlots`:
```ts
      const organizationId = (agent as { organizationId?: string | null }).organizationId ?? null;
      let orgSlots = Number.POSITIVE_INFINITY;
      if (organizationId) {
        const cap = normalizeOrgConcurrencyCap((agent as { orgConcurrencyCap?: number | null }).orgConcurrencyCap ?? null);
        const orgRunning = await countRunningRunsForOrg(db, organizationId);
        orgSlots = orgAvailableSlots({ cap, running: orgRunning });
      }
      const effectiveSlots = Math.min(availableSlots, orgSlots);
      if (effectiveSlots <= 0) return [];
```
Replace the subsequent `.limit(availableSlots)` with `.limit(effectiveSlots)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- org-concurrency`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/org-concurrency.ts server/src/services/heartbeat.ts server/src/__tests__/org-concurrency.test.ts
git commit -m "feat(mt-phase5): per-organization concurrency clamp layered on the per-agent clamp"
```

---

## Task 11: Read-only org spend rollup

**Files:**
- Create: `server/src/services/org-spend.ts`, `server/src/routes/org-spend.ts`
- Modify: `server/src/app.ts` (mount the router inside `createApp(db, ...)`)
- Test: `server/src/__tests__/org-spend.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/org-spend.test.ts
import { describe, expect, it } from "vitest";
import { summarizeOrgSpend } from "../services/org-spend.js";

describe("summarizeOrgSpend", () => {
  it("rolls up cost_events rows by provider and total cents", () => {
    const summary = summarizeOrgSpend([
      { provider: "anthropic", costCents: 120 },
      { provider: "anthropic", costCents: 80 },
      { provider: "openai", costCents: 50 },
    ]);
    expect(summary.totalCents).toBe(250);
    expect(summary.byProvider).toEqual([
      { provider: "anthropic", costCents: 200 },
      { provider: "openai", costCents: 50 },
    ]);
  });
  it("returns zero for no rows", () => {
    expect(summarizeOrgSpend([])).toEqual({ totalCents: 0, byProvider: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- org-spend`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure rollup + DB reader + route**

```ts
// server/src/services/org-spend.ts
import { and, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companies, costEvents } from "@armyofagents/db";

export interface OrgSpendSummary {
  totalCents: number;
  byProvider: Array<{ provider: string; costCents: number }>;
}

export function summarizeOrgSpend(rows: Array<{ provider: string; costCents: number }>): OrgSpendSummary {
  const byProvider = new Map<string, number>();
  let totalCents = 0;
  for (const r of rows) {
    totalCents += r.costCents;
    byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + r.costCents);
  }
  return {
    totalCents,
    byProvider: [...byProvider.entries()].map(([provider, costCents]) => ({ provider, costCents })).sort((a, b) => b.costCents - a.costCents),
  };
}

export async function getOrgSpend(db: Db, organizationId: string, since: Date): Promise<OrgSpendSummary> {
  const companyRows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq((companies as { organizationId: typeof companies.id }).organizationId, organizationId));
  const ids = companyRows.map((r) => r.id);
  if (ids.length === 0) return { totalCents: 0, byProvider: [] };
  const rows = await db
    .select({ provider: costEvents.provider, costCents: costEvents.costCents })
    .from(costEvents)
    .where(and(inArray(costEvents.companyId, ids), gte(costEvents.occurredAt, since)));
  return summarizeOrgSpend(rows.map((r) => ({ provider: r.provider, costCents: Number(r.costCents) })));
}
```

```ts
// server/src/routes/org-spend.ts  (RBAC: org-admin / founder only; read-only GET)
// Follows the existing router-factory pattern (see server/src/routes/environments.ts:29
// `environmentRoutes(opts: { db?: Db })`) — NOT a global getDb().
import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { getOrgSpend } from "../services/org-spend.js";

export function orgSpendRoutes(opts: { db: Db }) {
  const router = Router();
  router.get("/organizations/:orgId/spend", async (req, res) => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const summary = await getOrgSpend(opts.db, req.params.orgId, since);
    res.json(summary);
  });
  return router;
}
```
Mount it in `server/src/app.ts` inside `createApp(db, ...)` next to the other `*.use(...)` router mounts, e.g. `app.use("/api", orgSpendRoutes({ db }))` (mirror how `environmentRoutes({ db })` is mounted). `companies.organization_id` exists (P1 merged first); an org with no member companies returns `{ totalCents: 0, byProvider: [] }` (empty set) — safe.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- org-spend`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/org-spend.ts server/src/routes/org-spend.ts server/src/app.ts server/src/__tests__/org-spend.test.ts
git commit -m "feat(mt-phase5): read-only org spend rollup (provider breakdown from cost_events)"
```

---

## Task 12: UI — gVisor option + target pin in EnvironmentsSection (pure mapping helper)

**Files:**
- Create: `ui/src/components/settings/sections/environment-target-form.ts`
- Modify: `ui/src/components/settings/sections/EnvironmentsSection.tsx:76-149,398-417,497-594`
- Test: `ui/src/components/settings/sections/environment-target-form.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/components/settings/sections/environment-target-form.test.ts
import { describe, expect, it } from "vitest";
import { buildGvisorConfig } from "./environment-target-form.js";

describe("buildGvisorConfig", () => {
  it("produces a valid gvisor sandbox config with runsc + isolation defaults", () => {
    const cfg = buildGvisorConfig({ image: "aoa/agent-base:latest", memory: "2g", cpus: "2", pidsLimit: "512" });
    expect(cfg).toEqual({
      provider: "gvisor",
      image: "aoa/agent-base:latest",
      runtime: "runsc",
      network: "none",
      isolation: { user: "1000:1000", capDropAll: true, noNewPrivileges: true, readOnlyRootfs: true, memory: "2g", cpus: "2", pidsLimit: 512 },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/ui test -- environment-target-form`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper + wire the `<select>`**

```ts
// ui/src/components/settings/sections/environment-target-form.ts
export function buildGvisorConfig(input: { image: string; memory: string; cpus: string; pidsLimit: string }): Record<string, unknown> {
  return {
    provider: "gvisor",
    image: input.image.trim(),
    runtime: "runsc",
    network: "none",
    isolation: {
      user: "1000:1000",
      capDropAll: true,
      noNewPrivileges: true,
      readOnlyRootfs: true,
      memory: input.memory.trim() || "2g",
      cpus: input.cpus.trim() || "2",
      pidsLimit: Number(input.pidsLimit) || 512,
    },
  };
}
```
Add a `gvisor` `<option>` to the Execution Target `<select>` (`EnvironmentsSection.tsx:413-416`), a gVisor sub-form (image/memory/cpus/pids) mirroring the e2b block (`:497-594`), and route its `config` through `buildGvisorConfig` in `buildEnvironmentInput` (`:292-302`). Add an optional "Pin to execution target" picker that sets `executionTargetId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/ui test -- environment-target-form`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/settings/sections/environment-target-form.ts ui/src/components/settings/sections/environment-target-form.test.ts ui/src/components/settings/sections/EnvironmentsSection.tsx
git commit -m "feat(mt-phase5): EnvironmentsSection gVisor target option + execution-target pin"
```

---

## Task 13: Registry CRUD service/route + worker self-register/heartbeat

**Files:**
- Modify: `server/src/services/execution-targets.ts` (add CRUD + `registerWorkerHeartbeat`)
- Create: `server/src/routes/execution-targets.ts`; mount in `server/src/app.ts`
- Test: `server/src/__tests__/execution-targets-service.test.ts` (unit, mock-DB) + `server/src/__tests__/execution-targets-heartbeat-isolation.integration.test.ts` (cross-tenant, embedded-pg, Linux CI)

- [ ] **Step 1: Write the failing tests (mock-DB unit + cross-org integration)**

```ts
// server/src/__tests__/execution-targets-service.test.ts
import { describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";
vi.mock("@armyofagents/db", async () => ({ executionTargets: makeTableProxy("execution_targets") }));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());
import { registerWorkerHeartbeat } from "../services/execution-targets.js";

describe("registerWorkerHeartbeat", () => {
  it("scopes the update to the target ID (never the slug) and reports rows updated", async () => {
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "t-1" }]) });
    const set = vi.fn().mockReturnValue({ where });
    const db = { update: vi.fn().mockReturnValue({ set }) } as unknown as Parameters<typeof registerWorkerHeartbeat>[0];
    const res = await registerWorkerHeartbeat(db, { targetId: "t-1", status: "active", capabilities: { runtimes: ["runsc"] } });
    expect(db.update).toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
    // "eq" is the stubbed operator return; proves .where was given the id predicate.
    expect(where).toHaveBeenCalledWith("eq");
    expect(res.updated).toBe(1);
  });
  it("reports zero updated when the target id is gone (fail-closed 404 at the route)", async () => {
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
    const set = vi.fn().mockReturnValue({ where });
    const db = { update: vi.fn().mockReturnValue({ set }) } as unknown as Parameters<typeof registerWorkerHeartbeat>[0];
    expect((await registerWorkerHeartbeat(db, { targetId: "missing" })).updated).toBe(0);
  });
});
```

```ts
// server/src/__tests__/execution-targets-heartbeat-isolation.integration.test.ts
// Runs on embedded-pg (Linux CI; Windows skips *.integration.test.ts). Proves M6:
// two orgs with the same slug — a heartbeat for one target NEVER touches the other.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionTargets } from "@armyofagents/db";
import { and, eq } from "drizzle-orm";
import { makeEmbeddedTestDb } from "./helpers/embedded-db.js"; // existing integration harness
import { registerWorkerHeartbeat } from "../services/execution-targets.js";

describe("execution-target heartbeat cross-org isolation", () => {
  let ctx: Awaited<ReturnType<typeof makeEmbeddedTestDb>>;
  beforeAll(async () => { ctx = await makeEmbeddedTestDb(); });
  afterAll(async () => { await ctx.teardown(); });

  it("a heartbeat scoped to one target id leaves an identically-slugged sibling untouched", async () => {
    const [a] = await ctx.db.insert(executionTargets).values({ organizationId: null, slug: "pool-1", kind: "pooled_gvisor", trustClass: "shared_multitenant", status: "offline" }).returning();
    const [b] = await ctx.db.insert(executionTargets).values({ organizationId: null, slug: "pool-1-b", kind: "pooled_gvisor", trustClass: "shared_multitenant", status: "offline" }).returning();
    await registerWorkerHeartbeat(ctx.db, { targetId: a.id, status: "active" });
    const rowA = await ctx.db.select().from(executionTargets).where(eq(executionTargets.id, a.id)).then((r) => r[0]);
    const rowB = await ctx.db.select().from(executionTargets).where(eq(executionTargets.id, b.id)).then((r) => r[0]);
    expect(rowA.status).toBe("active");
    expect(rowA.lastSeenAt).not.toBeNull();
    expect(rowB.status).toBe("offline");        // sibling untouched
    expect(rowB.lastSeenAt).toBeNull();
  });
});
```
> The integration harness (`makeEmbeddedTestDb`) is the same embedded-pg scaffold other `*.integration.test.ts` suites use; if the repo's helper has a different name, reuse that one — do not invent a second harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- execution-targets-service`
Expected: FAIL — `registerWorkerHeartbeat` not exported.

- [ ] **Step 3: Implement CRUD + heartbeat (idempotent, org-scoped)**

```ts
// server/src/services/execution-targets.ts — add to the file created in Task 4
import { eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { executionTargets } from "@armyofagents/db";

// M6: heartbeat is scoped to the authenticated worker's TARGET ID, never the
// slug. slug is unique only per (organization_id, slug), so a slug-scoped update
// would let org-1's worker token flip org-2's identically-slugged pool row. The
// worker token resolves to exactly one target id; update by that id only.
export async function registerWorkerHeartbeat(
  db: Db,
  input: { targetId: string; status?: "active" | "draining" | "offline"; capabilities?: Record<string, unknown> },
): Promise<{ updated: number }> {
  const rows = await db
    .update(executionTargets)
    .set({
      lastSeenAt: new Date(),
      status: input.status ?? "active",
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      updatedAt: new Date(),
    })
    .where(eq(executionTargets.id, input.targetId))
    .returning({ id: executionTargets.id });
  return { updated: rows.length };
}

export async function listExecutionTargets(db: Db, organizationId: string | null) {
  const rows = await db.select().from(executionTargets);
  return rows.filter((r) => r.organizationId == null || r.organizationId === organizationId);
}
```

```ts
// server/src/routes/execution-targets.ts
// Router-factory pattern (see server/src/routes/environments.ts:29). db is injected;
// no global getDb(). executionTargets table is imported from @armyofagents/db.
import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { executionTargets } from "@armyofagents/db";
import { createExecutionTargetSchema } from "@armyofagents/shared";
import { listExecutionTargets, registerWorkerHeartbeat } from "../services/execution-targets.js";
import { assertOrgAdmin, requireWorkerToken } from "./authz.js"; // org-admin gate + worker-token middleware

export function executionTargetRoutes(opts: { db: Db }) {
  const router = Router();

  // Owner registers a dedicated target (semi-manual: paste slug + endpoint).
  // RBAC: caller must be founder/org-admin of :orgId.
  router.post("/organizations/:orgId/execution-targets", async (req, res) => {
    await assertOrgAdmin(req, req.params.orgId);
    const parsed = createExecutionTargetSchema.safeParse(req.body);
    if (!parsed.success) { res.status(422).json({ error: parsed.error.issues }); return; }
    const [row] = await opts.db.insert(executionTargets).values({ organizationId: req.params.orgId, ...parsed.data }).returning();
    res.status(201).json(row);
  });

  router.get("/organizations/:orgId/execution-targets", async (req, res) => {
    await assertOrgAdmin(req, req.params.orgId);
    res.json(await listExecutionTargets(opts.db, req.params.orgId));
  });

  // Worker self-heartbeat: the worker token is bound to ONE target id. The
  // middleware resolves req.workerTargetId; the URL carries NO slug/org so a
  // caller can never address another tenant's row. Fail closed with 404 when
  // the id no longer exists.
  router.post("/execution-targets/heartbeat", requireWorkerToken, async (req, res) => {
    const targetId = (req as { workerTargetId?: string }).workerTargetId!;
    const { updated } = await registerWorkerHeartbeat(opts.db, {
      targetId,
      status: req.body?.status,
      capabilities: req.body?.capabilities,
    });
    if (updated === 0) { res.status(404).json({ error: "execution target not found" }); return; }
    res.status(204).end();
  });

  return router;
}
```
Mount in `server/src/app.ts` inside `createApp(db, ...)`: `app.use("/api", executionTargetRoutes({ db }))` (mirror the `environmentRoutes({ db })` mount). RBAC: `assertOrgAdmin` (founder/org-admin, see `server/src/routes/authz.ts`) for POST/GET; `requireWorkerToken` (resolves the token → its single bound `req.workerTargetId`) for the heartbeat endpoint.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- execution-targets-service`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/execution-targets.ts server/src/routes/execution-targets.ts server/src/app.ts server/src/__tests__/execution-targets-service.test.ts server/src/__tests__/execution-targets-heartbeat-isolation.integration.test.ts
git commit -m "feat(mt-phase5): execution-target registry CRUD + id-scoped worker heartbeat (M6) + org-admin RBAC"
```

---

## Task 14: Docs + decision record + full verify

**Files:**
- Modify: `docs/architecture/decisions.md`, `docs/deploy/environment-variables.md`

- [ ] **Step 1: Add the decision record**

Append a new locked decision to `docs/architecture/decisions.md` summarizing: `execution_targets` registry (tenant-scoped, control-plane seed), gVisor via hardened `sandbox-docker` + `--runtime=runsc` (opt-in), conditional `--add-host` SSRF fix, route-by-credential (business key → pooled_gvisor, personal_subscription → dedicated), per-org concurrency clamp, and the egress posture: `--network none` default; `bridge` allowed for the pool ONLY with the worker-image egress firewall (DENY RFC1918 + `169.254.169.254` + control-plane; ALLOW provider hosts); app layer does not filter egress. Note self-hosted single-tenant unchanged.

- [ ] **Step 2: Document env/egress**

In `docs/deploy/environment-variables.md`, note that `AOA_EXECUTION_TARGET_ID` now corresponds to an `execution_targets.slug` row (seeded `control-plane`) and document the pool egress allowlist policy (from Task 0's `gvisor-worker-image.md`).

- [ ] **Step 3: Full verify**

Run: `pnpm -w typecheck && pnpm --filter @armyofagents/adapter-utils test && pnpm --filter @armyofagents/shared test && pnpm --filter @armyofagents/db test && pnpm --filter @armyofagents/server test && pnpm gen:tools:check`
Expected: PASS (Windows skips `*.integration.test.ts` + e2e — those run only on Linux CI).

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/decisions.md docs/deploy/environment-variables.md
git commit -m "docs(mt-phase5): decision record + execution-target/egress env docs"
```

---

## Test strategy summary

- **Pure, Windows-safe (the core):** `buildDockerRunArgs` hardening + conditional `--add-host` (Task 2), `resolveAdapterExecutionTarget` parse (Task 3), constants (Task 1), `chooseExecutionTargetRow` routing (Task 8), `orgAvailableSlots`/`normalizeOrgConcurrencyCap` (Task 10), `summarizeOrgSpend` (Task 11), `buildGvisorConfig` (Task 12), `resolveGvisorSandboxTarget` (Task 6), `mergeResolvedExecutionTarget` (Task 9). These verify the entire hardening + routing surface without docker/gVisor.
- **Mock-DB (drizzle-mock helper):** registry heartbeat (Task 13), and any service that touches the DB — declare a local sequence-DB per the `helpers/drizzle-mock.ts` NOTE.
- **Schema shape:** `getTableConfig` assertions (Task 4).
- **gVisor/docker EXECUTION is never run on Windows or in the standard suite** — it is validated only by (a) mocked `run`/injected pool client, and (b) the Task 0 Linux/Hetzner spike + an advisory Linux lane. Never a required gate.
- **Regression guard:** the "legacy profile is unchanged" case (Task 2) locks back-compat; `heartbeat-env-injection` re-run (Task 9) proves the env merge is untouched.

## Open risks / follow-ups (post-PR)

- P1 (merged first) supplies `organizations`, `companies.organization_id`, and `organizations.concurrency_cap`; the `execution_targets.organization_id` FK, the org concurrency gate, and the spend rollup all reference those real columns. Companies with no org stay unclamped (single-tenant/self-hosted safe).
- P4 supplies the normalized `{ credentialKind, executionTargetSlug }` seam and owns the `heartbeat.ts:2946-4035` region (P4-first; Task 12(b) deletes `:3991-4035` into a `legacySubscriptionEnv` closure). Phase 5 Task 9 consumes that seam by name and MUST land after P4 — it does not read `provider_credentials` directly and does not relocate P4's throw.
- Real gVisor **pool transport** (multi-worker `GvisorPoolClient` implementation + worker token auth) is a follow-up; the single-box beta runs the hardened `sandbox-docker` path directly.
- **Egress residual (M7):** the app layer only sets `--network none` (safe default) + opt-in conditional host-gateway. Real egress FILTERING lives in the worker image and is a HARD Task-0 deliverable (firewall: DENY RFC1918 + `169.254.169.254` + control-plane, ALLOW provider hosts). **A cloud pool running on `bridge` WITHOUT that firewall is unshippable** — the plan claims no egress protection for `bridge` until checkpoint D passes. `--network none` runs cannot reach the provider API, so any pool needing provider egress depends on the firewall shipping.

## Self-review notes

- Spec coverage: registry (T4/T5/T13), gVisor provider + hardening (T2/T3/T6/T7), route-by-credential + throw replacement (T8/T9), per-org cap (T10), org spend (T11), Task-0 spike gate (T0), conditional `--add-host` SSRF fix (T2), UI (T12), docs (T14) — all present.
- Type consistency: `AdapterDockerIsolation` (T1) is the single isolation shape used by T2/T3/T6/T8/T12; `ExecutionTargetRow` (T8) fields match the `execution_targets` columns (T4); `chooseExecutionTargetRow` kinds match `EXECUTION_TARGET_KINDS` (T1).
- No placeholders: every code step shows real code; every run step gives an exact command + expected result.
