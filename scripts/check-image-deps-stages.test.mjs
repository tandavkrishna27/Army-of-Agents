#!/usr/bin/env node
/**
 * check-image-deps-stages.test.mjs — corpus for the split-image deps-stage
 * parity gate (DEP-001).
 *
 * Run with:
 *   node --test scripts/check-image-deps-stages.test.mjs
 *
 * Each case builds a minimal workspace (a few `@armyofagents/*` manifests) plus
 * the two split Dockerfiles under an isolated root, runs `runDepsStageCheck`,
 * and asserts parity holds or the exact violation. It proves:
 *   - the exact-closure baseline passes clean;
 *   - a worker deps stage that COPYs server/db FAILS (E4-D01 headline: no
 *     server/db in the worker image);
 *   - a control-plane deps stage MISSING a closure manifest FAILS;
 *   - a control-plane deps stage that COPYs an OUT-OF-CLOSURE manifest (cli)
 *     FAILS (least-privilege "no more");
 *   - a missing `deps` stage / missing Dockerfile is reported.
 *
 * E6-F012 added TWO further, separately-reported questions about the NEXT stage:
 *   (a)+(b) does the `build` stage ABSORB the wider set `pnpm --filter "X..." build`
 *           selects (it traverses devDependencies; the deps stage's closure does not)?
 *   (a2)    is what the build line SELECTS actually covered by what an install there
 *           selected? (a) tests only the FLAG on the re-install and is satisfied by an
 *           install that absorbs nothing — measured, on the real tree.
 * Those cases are grouped at the bottom of this file. Two of them exist specifically to
 * pin the (a)/(b) rule as CONDITIONAL: an image with no divergence owes nothing, and one
 * workspace devDependency is what flips the obligation on — with the deps-stage verdict
 * provably unmoved, because the wrong fix is to widen `deps`.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runDepsStageCheck } from "./check-image-deps-stages.mjs";

// A minimal workspace. Closures:
//   control-plane {server, ui} -> server, ui, packages/db, packages/shared, packages/worker-protocol
//   worker {worker-daemon, worker-networked-host}
//                              -> worker-daemon, worker-protocol, worker-networked-host,
//                                 provider-wire, provider-capability, sandbox-e2b-provider,
//                                 sandbox-provider-contract (7). Blocker B gave DEP-011's
//                                 CONTAINER boot root an image home, so the worker closure is
//                                 no longer the two-package E4-D01 set. Same shape as the
//                                 adapter-manager's, minus adapter-manager itself.
//   adapter-manager            -> adapter-manager, provider-wire, sandbox-e2b-provider,
//                                 worker-daemon, worker-protocol, provider-capability,
//                                 sandbox-provider-contract (7). provider-capability is a
//                                 DEVdep of adapter-manager but a RUNTIME dep of provider-wire
//                                 (so it IS in the closure); sandbox-fake-provider is a devDep
//                                 of sandbox-provider-contract only (so it is NOT).
const WORKSPACE = {
  "server/package.json": {
    name: "@armyofagents/server",
    dependencies: {
      "@armyofagents/db": "workspace:*",
      "@armyofagents/shared": "workspace:*",
      "@armyofagents/worker-protocol": "workspace:*",
    },
  },
  "ui/package.json": {
    name: "@armyofagents/ui",
    dependencies: { "@armyofagents/shared": "workspace:*" },
  },
  "cli/package.json": {
    name: "@armyofagents/cli",
    dependencies: { "@armyofagents/shared": "workspace:*" },
  },
  "packages/db/package.json": {
    name: "@armyofagents/db",
    dependencies: { "@armyofagents/shared": "workspace:*" },
  },
  "packages/shared/package.json": { name: "@armyofagents/shared", dependencies: {} },
  "packages/worker-protocol/package.json": {
    name: "@armyofagents/worker-protocol",
    dependencies: { zod: "3.24.2" },
  },
  "packages/worker-daemon/package.json": {
    name: "@armyofagents/worker-daemon",
    dependencies: { "@armyofagents/worker-protocol": "workspace:*", pino: "^9.6.0" },
    devDependencies: { "@armyofagents/shared": "workspace:*" },
  },
  // --- adapter-manager runtime closure (DEP-012 Slice 4+5) ---
  "packages/adapter-manager/package.json": {
    name: "@armyofagents/adapter-manager",
    dependencies: {
      "@armyofagents/provider-wire": "workspace:*",
      "@armyofagents/sandbox-e2b-provider": "workspace:*",
      "@armyofagents/worker-daemon": "workspace:*",
    },
    // provider-capability is a DEVdep here — reached at runtime ONLY via provider-wire.
    devDependencies: { "@armyofagents/provider-capability": "workspace:*" },
  },
  "packages/provider-wire/package.json": {
    name: "@armyofagents/provider-wire",
    dependencies: {
      "@armyofagents/provider-capability": "workspace:*",
      "@armyofagents/sandbox-e2b-provider": "workspace:*",
      "@armyofagents/worker-daemon": "workspace:*",
      "@armyofagents/worker-protocol": "workspace:*",
    },
  },
  "packages/sandbox-e2b-provider/package.json": {
    name: "@armyofagents/sandbox-e2b-provider",
    dependencies: {
      "@armyofagents/sandbox-provider-contract": "workspace:*",
      "@armyofagents/worker-daemon": "workspace:*",
      "@armyofagents/worker-protocol": "workspace:*",
      e2b: "^2.30.5",
      zod: "3.24.2",
    },
  },
  "packages/provider-capability/package.json": {
    name: "@armyofagents/provider-capability",
    dependencies: {},
    // worker-daemon here is a TYPE-only devDep — never pulled into the runtime closure.
    devDependencies: { "@armyofagents/worker-daemon": "workspace:*" },
  },
  "packages/sandbox-provider-contract/package.json": {
    name: "@armyofagents/sandbox-provider-contract",
    dependencies: { "@armyofagents/worker-protocol": "workspace:*", zod: "3.24.2" },
    // sandbox-fake-provider is a devDep only — deliberately OUT of the runtime closure.
    devDependencies: { "@armyofagents/sandbox-fake-provider": "workspace:*" },
  },
  "packages/sandbox-fake-provider/package.json": {
    name: "@armyofagents/sandbox-fake-provider",
    dependencies: { "@armyofagents/worker-protocol": "workspace:*" },
  },
  // --- DEP-011 Slice 2b: the CONTAINER networked-provider boot root (Blocker B) ---
  "packages/worker-networked-host/package.json": {
    name: "@armyofagents/worker-networked-host",
    dependencies: {
      "@armyofagents/provider-wire": "workspace:*",
      "@armyofagents/worker-daemon": "workspace:*",
    },
  },
};

const CONTROL_DEPS = [
  "COPY server/package.json server/",
  "COPY ui/package.json ui/",
  "COPY packages/db/package.json packages/db/",
  "COPY packages/shared/package.json packages/shared/",
  "COPY packages/worker-protocol/package.json packages/worker-protocol/",
];
// The worker closure is SEVEN packages since Blocker B (was two). `sandbox-fake-provider` is
// still deliberately absent: it is a devDep of sandbox-provider-contract, so it is outside the
// RUNTIME closure this stage installs, and `pnpm deploy --prod` prunes it from the shipped tree.
const WORKER_DEPS = [
  "COPY packages/worker-daemon/package.json packages/worker-daemon/",
  "COPY packages/worker-protocol/package.json packages/worker-protocol/",
  "COPY packages/worker-networked-host/package.json packages/worker-networked-host/",
  "COPY packages/provider-wire/package.json packages/provider-wire/",
  "COPY packages/provider-capability/package.json packages/provider-capability/",
  "COPY packages/sandbox-e2b-provider/package.json packages/sandbox-e2b-provider/",
  "COPY packages/sandbox-provider-contract/package.json packages/sandbox-provider-contract/",
];
const ADAPTER_DEPS = [
  "COPY packages/adapter-manager/package.json packages/adapter-manager/",
  "COPY packages/provider-wire/package.json packages/provider-wire/",
  "COPY packages/sandbox-e2b-provider/package.json packages/sandbox-e2b-provider/",
  "COPY packages/worker-daemon/package.json packages/worker-daemon/",
  "COPY packages/worker-protocol/package.json packages/worker-protocol/",
  "COPY packages/provider-capability/package.json packages/provider-capability/",
  "COPY packages/sandbox-provider-contract/package.json packages/sandbox-provider-contract/",
];

// E6-F012 — the DEFAULT build stage. `COPY . .` + a non-prod re-install is the
// control-plane/adapter-manager shape: whatever the dev closure turns out to be, the
// whole tree is present and the install covers it. Passing `null` omits the build
// stage entirely (legal ONLY where the dev closure equals the prod closure); passing
// an array models the worker's SELECTIVE shape, which copies named paths and must
// therefore name every build-only package itself.
const ABSORBING_BUILD = ["COPY . .", "RUN pnpm install --frozen-lockfile"];

function dockerfile(depsCopies, buildLines = ABSORBING_BUILD) {
  return [
    "FROM node@sha256:" + "0".repeat(64) + " AS base",
    "FROM base AS deps",
    "WORKDIR /app",
    "COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./",
    ...depsCopies,
    "COPY patches/ patches/",
    'RUN pnpm install --frozen-lockfile',
    ...(buildLines === null ? [] : ["FROM deps AS build", ...buildLines]),
    "FROM base AS production",
    'CMD ["node","x.js"]',
    "",
  ].join("\n");
}

function setup(
  t,
  {
    control = dockerfile(CONTROL_DEPS),
    worker = dockerfile(WORKER_DEPS),
    adapterManager = dockerfile(ADAPTER_DEPS),
    // E6-F012: overlay manifests onto WORKSPACE, so a case can add the ONE workspace
    // devDependency whose whole point is that it changes nothing the deps-stage pass
    // can see.
    manifests = {},
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ideps-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, obj] of Object.entries({ ...WORKSPACE, ...manifests })) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(obj, null, 2));
  }
  const write = (rel, text) => {
    if (text === null) return;
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  write("docker/control-plane/Dockerfile", control);
  write("docker/worker/Dockerfile", worker);
  write("docker/adapter-manager/Dockerfile", adapterManager);
  return root;
}

const hasSubstr = (arr, sub) => arr.some((e) => e.includes(sub));

test("exact-closure baseline passes clean", (t) => {
  const root = setup(t);
  const { errors } = runDepsStageCheck(root);
  assert.deepEqual(errors, [], errors.join(" | "));
});

test("E4-D01: worker deps stage that COPYs server FAILS (out-of-closure)", (t) => {
  const root = setup(t, {
    worker: dockerfile([...WORKER_DEPS, "COPY server/package.json server/"]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(errors, "worker: deps stage COPYs server/package.json which is OUTSIDE the image closure"),
    errors.join(" | "),
  );
});

test("E4-D01: worker deps stage that COPYs packages/db FAILS (out-of-closure)", (t) => {
  const root = setup(t, {
    worker: dockerfile([...WORKER_DEPS, "COPY packages/db/package.json packages/db/"]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(errors, "worker: deps stage COPYs packages/db/package.json which is OUTSIDE the image closure"),
    errors.join(" | "),
  );
});

// ★ Blocker B — the worker closure widened from 2 to 7. The pre-existing worker cases only
// prove the OUT-of-closure direction (server, packages/db). Without these two, the widening
// could be silently un-done: dropping the networked-host manifest, or dropping the whole entry
// package from the guard, would leave every other test green while the image stops installing
// what it needs to build — and CI runs NO docker build to notice.

test("Blocker B: worker deps stage MISSING worker-networked-host FAILS", (t) => {
  const trimmed = WORKER_DEPS.filter((l) => !l.includes("packages/worker-networked-host/"));
  const root = setup(t, { worker: dockerfile(trimmed) });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(errors, "worker: deps stage is MISSING closure manifest: COPY packages/worker-networked-host/package.json"),
    errors.join(" | "),
  );
});

test("Blocker B: worker deps stage MISSING provider-wire (closure via worker-networked-host) FAILS", (t) => {
  // provider-wire is reached ONLY through the new entry package. If someone reverted
  // `entryPackages` to the old single daemon, this case would go green while the image broke —
  // so this is the assertion that pins the SECOND entry package specifically.
  const trimmed = WORKER_DEPS.filter((l) => !l.includes("packages/provider-wire/"));
  const root = setup(t, { worker: dockerfile(trimmed) });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(errors, "worker: deps stage is MISSING closure manifest: COPY packages/provider-wire/package.json"),
    errors.join(" | "),
  );
});

test("Blocker B: worker deps stage COPYing sandbox-fake-provider (devDep, out-of-closure) FAILS", (t) => {
  // The build stage DOES copy fake-provider's manifest (tsc needs it), but the DEPS stage must
  // not: that stage is the runtime closure, and `pnpm deploy --prod` prunes fake-provider from
  // the shipped tree. A fabricating provider in the runtime install is exactly what WRK-009's
  // unscoped image assertion exists to catch — this catches it one layer earlier.
  const root = setup(t, {
    worker: dockerfile([...WORKER_DEPS, "COPY packages/sandbox-fake-provider/package.json packages/sandbox-fake-provider/"]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(errors, "worker: deps stage COPYs packages/sandbox-fake-provider/package.json which is OUTSIDE the image closure"),
    errors.join(" | "),
  );
});

test("control-plane deps stage MISSING a closure manifest (packages/db) FAILS", (t) => {
  const trimmed = CONTROL_DEPS.filter((l) => !l.includes("packages/db/"));
  const root = setup(t, { control: dockerfile(trimmed) });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(errors, "control-plane: deps stage is MISSING closure manifest: COPY packages/db/package.json"),
    errors.join(" | "),
  );
});

test("control-plane deps stage COPYing cli (out-of-closure) FAILS least-privilege", (t) => {
  const root = setup(t, {
    control: dockerfile([...CONTROL_DEPS, "COPY cli/package.json cli/"]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(errors, "control-plane: deps stage COPYs cli/package.json which is OUTSIDE the image closure"),
    errors.join(" | "),
  );
});

test("a Dockerfile with no 'AS deps' stage is reported", (t) => {
  const noDeps = ["FROM node@sha256:" + "0".repeat(64) + " AS base", "FROM base AS production", ""].join("\n");
  const root = setup(t, { worker: noDeps });
  const { errors } = runDepsStageCheck(root);
  assert.ok(hasSubstr(errors, "worker: could not find a 'FROM ... AS deps' stage"), errors.join(" | "));
});

test("a missing Dockerfile is reported", (t) => {
  const root = setup(t);
  fs.rmSync(path.join(root, "docker/worker/Dockerfile"));
  const { errors } = runDepsStageCheck(root);
  assert.ok(hasSubstr(errors, "worker: Dockerfile not found"), errors.join(" | "));
});

test("DEP-012: adapter-manager exact 7-package closure passes clean", (t) => {
  // The default setup writes the AM Dockerfile with ADAPTER_DEPS (the exact closure).
  const root = setup(t);
  const { errors } = runDepsStageCheck(root);
  assert.deepEqual(errors, [], errors.join(" | "));
});

test("DEP-012: adapter-manager deps stage COPYing server (out-of-closure) FAILS", (t) => {
  const root = setup(t, {
    adapterManager: dockerfile([...ADAPTER_DEPS, "COPY server/package.json server/"]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(errors, "adapter-manager: deps stage COPYs server/package.json which is OUTSIDE the image closure"),
    errors.join(" | "),
  );
});

test("DEP-012: adapter-manager deps stage COPYing sandbox-fake-provider (devDep, out-of-closure) FAILS", (t) => {
  const root = setup(t, {
    adapterManager: dockerfile([
      ...ADAPTER_DEPS,
      "COPY packages/sandbox-fake-provider/package.json packages/sandbox-fake-provider/",
    ]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(
      errors,
      "adapter-manager: deps stage COPYs packages/sandbox-fake-provider/package.json which is OUTSIDE the image closure",
    ),
    errors.join(" | "),
  );
});

test("DEP-012: adapter-manager deps stage MISSING provider-capability (closure via provider-wire) FAILS", (t) => {
  const trimmed = ADAPTER_DEPS.filter((l) => !l.includes("packages/provider-capability/"));
  const root = setup(t, { adapterManager: dockerfile(trimmed) });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(errors, "adapter-manager: deps stage is MISSING closure manifest: COPY packages/provider-capability/package.json"),
    errors.join(" | "),
  );
});

test("COPY with a --chown flag is still parsed for its workspace source", (t) => {
  const control = dockerfile(
    CONTROL_DEPS.map((l) => l.replace("COPY ", "COPY --chown=node:node ")),
  );
  const root = setup(t, { control });
  const { errors } = runDepsStageCheck(root);
  assert.deepEqual(errors, [], errors.join(" | "));
});

// ===========================================================================
// E6-F012 — the build-stage ABSORPTION clauses.
//
// The cases above all reason about the deps stage: what is INSTALLED. These
// reason about the stage after it: `pnpm --filter "X..." build` traverses
// devDependencies, so what is BUILT can be a strictly larger set, and nothing
// used to say so. The rule is conditional — no divergence, no obligation — and
// the first two cases here are what stops it becoming the unconditional
// "copy the dev closure into deps" rule that would destroy least privilege.
//
// Fixture divergences (build closure minus runtime closure):
//   control-plane {server, ui} .......... 0  (no workspace devDeps in reach)
//   worker {daemon, networked-host} ..... 2  (shared via worker-daemon's devDep,
//                                             sandbox-fake-provider via the contract's)
//   adapter-manager ..................... 2  (the same two)
// ===========================================================================

const WORKER_SELECTIVE_BUILD = [
  // The REAL worker build stage's shape: named copies, never `COPY . .` (a whole-tree
  // copy would make every `dockerfile-static` exclusion grep vacuous). It must
  // therefore name the build-only packages itself.
  "COPY tsconfig.json ./",
  "COPY packages/shared/package.json packages/shared/",
  "COPY packages/sandbox-fake-provider/package.json packages/sandbox-fake-provider/",
  "RUN pnpm install --frozen-lockfile",
];

test("E6-F012: no divergence ⇒ NO build-stage obligation (control-plane needs no re-install)", (t) => {
  // The conditional, asserted directly. control-plane's fixture closure has no
  // workspace devDependency in reach, so a Dockerfile with no build stage AT ALL is
  // legal. If this ever reds, the guard has become the unconditional rule that would
  // force the dev closure into the deps stage — the thing E6-F012 says not to do.
  const root = setup(t, { control: dockerfile(CONTROL_DEPS, null) });
  const { errors } = runDepsStageCheck(root);
  assert.deepEqual(errors, [], errors.join(" | "));
});

test("E6-F012: ONE workspace devDependency flips the obligation on", (t) => {
  // The exact commit class from `c3d26657d`, minimized: a single workspace DEVdependency
  // added to an entry package. Nothing the deps-stage pass looks at changes — the prod
  // closure, and therefore the required COPY set, is byte-identical — yet `pnpm --filter
  // "@armyofagents/ui..." build` now selects `cli` too. Before this clause existed, this
  // diff was invisible to every check in the repo.
  const root = setup(t, {
    control: dockerfile(CONTROL_DEPS, null),
    manifests: {
      "ui/package.json": {
        name: "@armyofagents/ui",
        dependencies: { "@armyofagents/shared": "workspace:*" },
        devDependencies: { "@armyofagents/cli": "workspace:*" },
      },
    },
  });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(
      errors,
      "control-plane: the build closure exceeds the runtime closure by 1 package(s) (@armyofagents/cli) but there is no 'FROM ... AS build' stage",
    ),
    errors.join(" | "),
  );
  // …and it must NOT have moved the deps-stage verdict. If it had, the fix would be
  // "COPY cli into deps", which is precisely the least-privilege violation the older
  // cases in this file exist to reject.
  assert.equal(
    errors.filter((e) => e.includes("deps stage")).length,
    0,
    "the deps-stage verdict must be untouched by a devDependency: " + errors.join(" | "),
  );
});

test("E6-F012: a diverging image whose build stage has NO re-install FAILS", (t) => {
  const root = setup(t, { worker: dockerfile(WORKER_DEPS, ["COPY . ."]) });
  const { errors } = runDepsStageCheck(root);
  assert.ok(hasSubstr(errors, "worker: the build closure exceeds the runtime closure by 2 package(s)"), errors.join(" | "));
  assert.ok(hasSubstr(errors, "has NO re-install"), errors.join(" | "));
});

test("E6-F012: a build-stage re-install that is --filter-prod absorbs NOTHING and FAILS", (t) => {
  // The trap both real Dockerfiles' comments warn about, from the other direction:
  // `--filter-prod` in the BUILD stage re-selects the runtime closure, so the install
  // runs, looks like the fix, and installs exactly the set that was already there.
  const root = setup(t, {
    worker: dockerfile(WORKER_DEPS, [
      "COPY . .",
      'RUN pnpm install --frozen-lockfile --filter-prod "@armyofagents/worker-networked-host..."',
    ]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.ok(hasSubstr(errors, "worker: the 'build' stage re-installs, but every pnpm install there is --prod/--filter-prod"), errors.join(" | "));
});

test("E6-F012: --filter-prod on a CONTINUATION line is still seen", (t) => {
  // `logicalLines` joins backslash continuations. Without that, the flag below sits on
  // its own line, the RUN line reads as a bare `pnpm install`, and the case above passes
  // while the image is in exactly the state it rejects.
  const root = setup(t, {
    worker: dockerfile(WORKER_DEPS, [
      "COPY . .",
      "RUN pnpm install --frozen-lockfile \\",
      '  --filter-prod "@armyofagents/worker-networked-host..."',
    ]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.ok(hasSubstr(errors, "worker: the 'build' stage re-installs, but every pnpm install there is --prod/--filter-prod"), errors.join(" | "));
});

test("E6-F012: a SELECTIVE build stage naming every build-only manifest passes clean", (t) => {
  const root = setup(t, { worker: dockerfile(WORKER_DEPS, WORKER_SELECTIVE_BUILD) });
  const { errors } = runDepsStageCheck(root);
  assert.deepEqual(errors, [], errors.join(" | "));
});

test("E6-F012: a SELECTIVE build stage MISSING a build-only manifest FAILS", (t) => {
  // The clause that makes this guard bite for the worker image specifically. The
  // re-install is present and correct; it simply has nothing to resolve, because the
  // package's directory never entered the stage. `pnpm install --frozen-lockfile` and
  // then `tsc` both fail here — at build time, in a lane that is not a required check.
  const trimmed = WORKER_SELECTIVE_BUILD.filter((l) => !l.includes("sandbox-fake-provider"));
  const root = setup(t, { worker: dockerfile(WORKER_DEPS, trimmed) });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(
      errors,
      "worker: build-only closure package @armyofagents/sandbox-fake-provider has no manifest in the 'build' stage",
    ),
    errors.join(" | "),
  );
  // The remedy the message names must be the SAFE one: copy it into `build`, never into
  // `deps`. A guard whose error message advises the least-privilege violation is worse
  // than no guard.
  assert.ok(hasSubstr(errors, "never to deps"), errors.join(" | "));
});

test("E6-F012: a whole-directory COPY covers the manifests beneath it", (t) => {
  // `COPY packages/ packages/` is a legal delivery route and must not be read as absence.
  const root = setup(t, {
    worker: dockerfile(WORKER_DEPS, ["COPY packages/ packages/", "RUN pnpm install --frozen-lockfile"]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.deepEqual(errors, [], errors.join(" | "));
});

test("E6-F012: a cross-stage COPY --from= is NOT counted as manifest coverage", (t) => {
  // `COPY --from=deps /app /app` moves an installed tree, not source manifests, and the
  // deps stage by construction does not contain the build-only packages. Counting it
  // would make the coverage clause vacuous for both `COPY . .` images.
  const root = setup(t, {
    worker: dockerfile(WORKER_DEPS, ["COPY --from=deps /app /app", "RUN pnpm install --frozen-lockfile"]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.ok(hasSubstr(errors, "worker: build-only closure package @armyofagents/shared has no manifest"), errors.join(" | "));
  assert.ok(
    hasSubstr(errors, "worker: build-only closure package @armyofagents/sandbox-fake-provider has no manifest"),
    errors.join(" | "),
  );
});

test("E6-F012: `FROM deps AS build` inherits the deps stage's COPYs", (t) => {
  // Not cosmetic: the real worker build stage is `FROM deps`, and without following that
  // edge every one of the seven runtime manifests would read as absent from `build`. This
  // pins the inheritance by putting a build-only manifest in DEPS' reach via a directory
  // copy there — if the walk stopped at `build`, this would red.
  const root = setup(t, {
    worker: dockerfile([...WORKER_DEPS, "COPY packages/shared/package.json packages/shared/"], [
      "COPY packages/sandbox-fake-provider/package.json packages/sandbox-fake-provider/",
      "RUN pnpm install --frozen-lockfile",
    ]),
  });
  const { errors } = runDepsStageCheck(root);
  // `shared` in DEPS is an out-of-closure least-privilege violation — that error MUST
  // still fire — but it must NOT also be reported as missing from `build`.
  assert.ok(hasSubstr(errors, "worker: deps stage COPYs packages/shared/package.json which is OUTSIDE"), errors.join(" | "));
  assert.equal(
    errors.filter((e) => e.includes("build-only closure package")).length,
    0,
    "inheritance not followed: " + errors.join(" | "),
  );
});


// ===========================================================================
// E6-F012 clause (a2) — the BUILD selection vs the INSTALLED selection.
//
// ★ WHY THIS BLOCK EXISTS: clause (a) above tests a FLAG, not a SELECTION. It asks
// only "is there a `pnpm install` in this stage without `--prod`/`--filter-prod`?",
// so it is satisfied by an install that absorbs nothing. That was MEASURED on the
// real tree at `da1a90597`: narrowing the control-plane build stage's re-install to
// `--filter "@armyofagents/worker-protocol..."` while leaving its
// `--filter "@armyofagents/server..." --filter "@armyofagents/ui..." build` line alone
// left the entire gate GREEN — which is `c3d26657d`'s failure mode exactly. The first
// case below is that probe in fixture form, and it is the anti-regression pin.
//
// TWO fixture shapes are needed here and the difference is load-bearing:
//   * `dockerfile()` above emits `FROM deps AS build`, and its `deps` stage runs a
//     BARE `pnpm install` — the whole workspace. Inheritance therefore makes every
//     build line covered, which is CORRECT and is the fourth case below.
//   * the real control-plane and adapter-manager images use `FROM base AS build`,
//     so nothing is inherited and the stage's own install is the whole story. That
//     is `unrootedDockerfile()`, and it is the shape the measured probe lives in.
// A case written against the wrong one of these passes for the wrong reason.
// ===========================================================================

/**
 * The real control-plane/adapter-manager shape: a `build` stage rooted at `base`
 * rather than at `deps`, so it inherits NO install and NO COPYs.
 */
function unrootedDockerfile(depsCopies, depsInstall, buildLines) {
  return [
    "FROM node@sha256:" + "0".repeat(64) + " AS base",
    "FROM base AS deps",
    "WORKDIR /app",
    "COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./",
    ...depsCopies,
    "COPY patches/ patches/",
    depsInstall,
    "FROM base AS build",
    "COPY --from=deps /app /app",
    ...buildLines,
    "FROM base AS production",
    'CMD ["node","x.js"]',
    "",
  ].join("\n");
}

const CP_BUILD_LINE = 'RUN pnpm --filter "@armyofagents/server..." --filter "@armyofagents/ui..." build';
const CP_DEPS_INSTALL =
  'RUN pnpm install --frozen-lockfile --filter "@armyofagents/server..." --filter "@armyofagents/ui..."';

test("E6-F012 (a2): install and build selecting the SAME set passes clean", (t) => {
  const root = setup(t, {
    control: unrootedDockerfile(CONTROL_DEPS, CP_DEPS_INSTALL, [
      "COPY . .",
      CP_DEPS_INSTALL,
      CP_BUILD_LINE,
    ]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.deepEqual(errors, [], errors.join(" | "));
});

test("E6-F012 (a2): a build stage that BUILDS NOTHING owes clause (a2) nothing", (t) => {
  // The conditional, from the other side. The default fixture has an install and no
  // build line; the subset test has no left-hand side and must not invent one.
  const root = setup(t);
  const { errors } = runDepsStageCheck(root);
  assert.deepEqual(errors, [], errors.join(" | "));
});

test("E6-F012 (a2): an install INHERITED through `FROM deps` counts toward coverage", (t) => {
  // A build stage may legitimately rely on its parent's install — the real worker image
  // is `FROM deps AS build`, whose layer already holds that install. Reading installs
  // stage-locally would red this shape as a false positive.
  //
  // The local install here is deliberately a NARROW one that covers almost nothing, so
  // the parent's install is the ONLY thing covering server/ui/db/shared. Without it the
  // case reds with four uncovered packages — which is what makes this a real test of the
  // inheritance rather than of the "no install lines at all" early return.
  const root = setup(t, {
    control: dockerfile(CONTROL_DEPS, [
      "COPY . .",
      'RUN pnpm install --frozen-lockfile --filter "@armyofagents/worker-protocol..."',
      CP_BUILD_LINE,
    ]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.deepEqual(errors, [], errors.join(" | "));
});

test("E6-F012 (a2): a filter selector the parser cannot read is REPORTED, never silently skipped", (t) => {
  // A glob (or any selector syntax this parser does not model) must not be read as
  // "selects nothing" — that would turn the subset test into a vacuous pass, which is
  // this programme's signature failure. It is named, with the fix pointed at the parser.
  const root = setup(t, {
    control: unrootedDockerfile(CONTROL_DEPS, CP_DEPS_INSTALL, [
      "COPY . .",
      CP_DEPS_INSTALL,
      'RUN pnpm --filter "@armyofagents/*" build',
    ]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(errors, 'unparseable pnpm filter selector "@armyofagents/*" on a build line'),
    errors.join(" | "),
  );
  assert.ok(hasSubstr(errors, "teach parseFilterSelectors about it"), errors.join(" | "));
});


test("E6-F012 (a2): a non-prod re-install NARROWER than the build line FAILS while (a) and (b) both pass", (t) => {
  // ★ THE ANTI-REGRESSION PIN, and it is the measured evasion in fixture form.
  //
  // One workspace devDependency (`ui` -> `cli`) widens the build closure by one, exactly
  // as `c3d26657d` did. Then:
  //   clause (a) is SATISFIED  — the build stage does re-install, and non-prod.
  //   clause (b) is SATISFIED  — `COPY . .` puts cli's manifest in the stage.
  //   the deps stage cannot vouch for cli either: its `--filter "…/server…" "…/ui…"`
  //     runs where only the five runtime manifests exist, and pnpm's `...` walks the
  //     DISCOVERED workspace, so it installed five packages and not six.
  // …and `pnpm --filter "…/server…" --filter "…/ui…" build` still compiles cli, with no
  // node_modules. Only the SELECTION comparison sees it. Before clause (a2) existed the
  // whole gate returned "split-image deps-stage parity: PASS" on precisely this shape.
  const root = setup(t, {
    control: unrootedDockerfile(CONTROL_DEPS, CP_DEPS_INSTALL, [
      "COPY . .",
      'RUN pnpm install --frozen-lockfile --filter "@armyofagents/worker-protocol..."',
      CP_BUILD_LINE,
    ]),
    manifests: {
      "ui/package.json": {
        name: "@armyofagents/ui",
        dependencies: { "@armyofagents/shared": "workspace:*" },
        devDependencies: { "@armyofagents/cli": "workspace:*" },
      },
    },
  });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(
      errors,
      "control-plane: the 'build' stage BUILDS 1 package(s) that no install there selected (@armyofagents/cli)",
    ),
    errors.join(" | "),
  );
  // The remedy must name the SELECTION, not the flag — the flag is what misled here.
  assert.ok(hasSubstr(errors, "being non-prod is not enough"), errors.join(" | "));
  // …and the other two clauses must stay silent, or this case would prove nothing about (a2).
  assert.equal(
    errors.filter((e) => e.includes("has NO re-install") || e.includes("absorbs nothing") || e.includes("has no manifest")).length,
    0,
    "clauses (a)/(b) must be satisfied here: " + errors.join(" | "),
  );
});

test("E6-F012 (a2): a `COPY --from=<stage>` of the installed tree COUNTS as an install", (t) => {
  // The control-plane/adapter-manager shape. `COPY --from=deps /app /app` brings deps'
  // node_modules in wholesale, so the packages deps installed ARE resolvable here and
  // reporting them would be a false positive. This case has NO local install at all and
  // must pass; if the credit is ever dropped, every narrowed-but-legitimate build stage
  // starts crying wolf, and a guard that cries wolf gets deleted.
  const root = setup(t, {
    control: unrootedDockerfile(CONTROL_DEPS, CP_DEPS_INSTALL, ["COPY . .", CP_BUILD_LINE]),
  });
  const { errors } = runDepsStageCheck(root);
  assert.deepEqual(errors, [], errors.join(" | "));
});

test("E6-F012 (a2): a copy of something OTHER than the stage's workdir earns no install credit", (t) => {
  // The limit on the rule above. `COPY --from=deps /app/patches ./patches` moves no
  // install; crediting any `--from=` would let a narrowed re-install hide behind an
  // unrelated cross-stage copy.
  const control = unrootedDockerfile(CONTROL_DEPS, CP_DEPS_INSTALL, [
    "COPY . .",
    'RUN pnpm install --frozen-lockfile --filter "@armyofagents/worker-protocol..."',
    CP_BUILD_LINE,
  ]).replace("COPY --from=deps /app /app", "COPY --from=deps /app/patches ./patches");
  const root = setup(t, { control });
  const { errors } = runDepsStageCheck(root);
  assert.ok(
    hasSubstr(errors, "control-plane: the 'build' stage BUILDS 4 package(s) that no install there selected"),
    errors.join(" | "),
  );
});

test("E6-F012 (a2): a package ABSENT from the stage is left to clause (b), not double-reported", (t) => {
  // pnpm's `...` walks the DISCOVERED workspace, so a package whose directory never
  // entered the stage cannot be selected by the build line either. Clause (b) owns that
  // case and names the right remedy (copy the manifest into `build`, NEVER into `deps`);
  // clause (a2) must stay quiet about it, or one gap gets reported twice with two
  // different fixes and the reader follows the wrong one.
  //
  // Here `shared` IS present and uninstalled (a2's case) while `sandbox-fake-provider`
  // is absent (clause (b)'s case) — so the split is observable in a single run.
  const root = setup(t, {
    worker: unrootedDockerfile(
      WORKER_DEPS,
      'RUN pnpm install --frozen-lockfile --filter-prod "@armyofagents/worker-daemon..." --filter-prod "@armyofagents/worker-networked-host..."',
      [
        "COPY tsconfig.json ./",
        "COPY packages/shared/ packages/shared/",
        "COPY packages/worker-daemon/ packages/worker-daemon/",
        "COPY packages/worker-protocol/ packages/worker-protocol/",
        "COPY packages/worker-networked-host/ packages/worker-networked-host/",
        "COPY packages/provider-wire/ packages/provider-wire/",
        "COPY packages/provider-capability/ packages/provider-capability/",
        "COPY packages/sandbox-e2b-provider/ packages/sandbox-e2b-provider/",
        "COPY packages/sandbox-provider-contract/ packages/sandbox-provider-contract/",
        'RUN pnpm install --frozen-lockfile --filter "@armyofagents/worker-protocol..."',
        'RUN pnpm --filter "@armyofagents/worker-networked-host..." build',
      ],
    ),
  });
  const { errors } = runDepsStageCheck(root);
  const a2 = errors.filter((e) => e.includes("that no install there selected"));
  assert.equal(a2.length, 1, errors.join(" | "));
  assert.ok(a2[0].includes("@armyofagents/shared"), a2[0]);
  assert.ok(
    !a2[0].includes("sandbox-fake-provider"),
    "clause (a2) must not claim an ABSENT package as an install gap: " + a2[0],
  );
  assert.ok(
    hasSubstr(errors, "worker: build-only closure package @armyofagents/sandbox-fake-provider has no manifest"),
    errors.join(" | "),
  );
});

test("E6-F012 (a2): `pnpm ... run build` is recognised, `pnpm ... deploy --prod` is not", (t) => {
  // Two forms of the same thing must both count, or an image can rename its way out of
  // the check. `pnpm deploy --prod` is excluded for a plain reason and not by a special
  // case: it carries no whole-token `build`. All three real Dockerfiles run one in their
  // `build` stage, so reading it as a build selection would red correct images — and a
  // guard that reds correct Dockerfiles gets deleted rather than fixed.
  //
  // The deps credit is deliberately withheld (the cross-stage copy is of `patches`, not
  // the workdir) so the ONLY install is the narrow local one; otherwise this case would
  // pass no matter which lines were recognised.
  const mk = (lastLine) =>
    unrootedDockerfile(CONTROL_DEPS, CP_DEPS_INSTALL, [
      "COPY . .",
      'RUN pnpm install --frozen-lockfile --filter "@armyofagents/worker-protocol..."',
      lastLine,
    ]).replace("COPY --from=deps /app /app", "COPY --from=deps /app/patches ./patches");

  const built = runDepsStageCheck(
    setup(t, { control: mk('RUN pnpm --filter "@armyofagents/server..." run build') }),
  ).errors;
  assert.ok(
    built.some((e) => e.includes("the 'build' stage BUILDS 3 package(s) that no install there selected")),
    built.join(" | "),
  );

  const deployed = runDepsStageCheck(
    setup(t, { control: mk('RUN pnpm --filter "@armyofagents/server..." deploy --prod /cp-app') }),
  ).errors;
  assert.deepEqual(deployed, [], deployed.join(" | "));

  // …and `build` as a SUBSTRING is not a build line. Relaxing the token match to a
  // substring would make `prebuild`, `/app/build` and `build-info` all read as build
  // selections and red three correct images.
  const substring = runDepsStageCheck(
    setup(t, { control: mk('RUN pnpm --filter "@armyofagents/server..." exec node ./scripts/prebuild.mjs') }),
  ).errors;
  assert.deepEqual(substring, [], substring.join(" | "));
});
