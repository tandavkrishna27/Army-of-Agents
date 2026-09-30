// -----------------------------------------------------------------------------
// FIX 7 — mechanical, compile-time structural conformance of the fake to the port.
//
// This file is NOT a runtime vitest suite (it is excluded from test discovery in
// this package's vitest.config.ts). It exists purely so `tsc --noEmit` MECHANICALLY
// enforces that the DEP-000 fake's driver type structurally satisfies the
// contract's `SandboxProviderDriver` PORT. Previously the only fake→port
// assignability check lived at the `runSandboxProviderContract(...)` call sites in
// the excluded `*.test.ts` suites, so `tsc` never verified it (tsconfig excludes
// `*.test.ts`). This file is force-added back into the typecheck program via the
// package tsconfig `files` entry.
//
// It is a `.test.ts` because the DEP-000 boundary checker
// (scripts/lib/sandbox-fake-provider-boundary.mjs) forbids the contract package's
// RUNTIME source from importing the sibling fake package; only `.test.ts` files
// are exempt. Every import here is `import type` (no runtime footprint), so even
// if the build emits this file it carries no cross-package runtime dependency.
//
// If the fake drifts from the port shape (e.g. an `invoke` signature change), the
// `satisfies`/assignability assertions below FAIL `tsc`.
// -----------------------------------------------------------------------------

import type { FakeSandboxDriver, HostileSandboxProvider } from "@armyofagents/sandbox-fake-provider";
import type {
  SandboxProviderDriver,
  SandboxProviderDriverFactory,
} from "../index.js";

// A fake driver value is assignable to the contract driver port.
(null as unknown as FakeSandboxDriver) satisfies SandboxProviderDriver;

// A factory that produces a fake driver is assignable to the contract factory.
(null as unknown as () => FakeSandboxDriver) satisfies SandboxProviderDriverFactory;

// DEP-008 — the HOSTILE reference driver (a distinct SandboxProviderDriver) must
// ALSO structurally satisfy the contract port; mechanically enforced here so a
// signature drift FAILS `tsc` (the isolation suite consumes it as this port).
type HostileDriver = ReturnType<HostileSandboxProvider["makeDriver"]>;
(null as unknown as HostileDriver) satisfies SandboxProviderDriver;
(null as unknown as () => HostileDriver) satisfies SandboxProviderDriverFactory;

// Type-level, redundant belt-and-suspenders: both drivers extend the port.
type Expect<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;
type _FakeDriverExtendsPort = Expect<Extends<FakeSandboxDriver, SandboxProviderDriver>>;
type _HostileDriverExtendsPort = Expect<Extends<HostileDriver, SandboxProviderDriver>>;

// `export {}` keeps this an ES module under `isolatedModules`.
export type { _FakeDriverExtendsPort, _HostileDriverExtendsPort };
