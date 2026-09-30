// packages/worker-keystore/src/bin/desktop-host.ts
//
// DSK-001 — the composition host. THE ONLY FILE IN THE REPO THAT NAMES BOTH
// `@armyofagents/worker-daemon` AND this package's OS custody.
//
// That is the whole point of the arrangement. `scripts/check-worker-daemon-boundary.mjs`
// walks `packages/worker-daemon/src` and rejects a bare specifier the moment a
// file there names something outside the two-dependency pin — so the daemon
// declares the custody SHAPE and this file supplies an implementation. The
// dependency arrow points keystore → daemon and never back.
//
// **This is a developer host, not a product.** DSK-003 owns packaging, signing,
// notarization, autostart and uninstall. What this provides is a real production
// consumer for the adapter, so the custody path is exercised by something other
// than a test.
//
// It also owns the ONLY caller of `clear()`. Wiping a device identity is
// irreversible in the way that matters: the server denies a re-minted identity
// permanently and `findWorkerForBinding` has no status predicate, so a wipe that
// happens by accident is a machine that can never enrol again. It is therefore a
// deliberate, explicitly-named subcommand, never part of a normal boot, and
// GUARDED — it names the identity it would destroy, states the permanence, and
// requires a second acknowledgement argument unless the slot is provably empty.

import {
  bootstrapWorkerDaemon,
  type BootstrapResult,
  type ProcessLike,
  type SandboxProvider,
} from "@armyofagents/worker-daemon";

import { resolveVaultRefs } from "../blob-path.js";
import { createCommandRunner } from "../command-runner.js";
import { createOsRecordStore, type CommandRunner } from "../identity-store.js";
import {
  decodeIdentityEnvelope,
  encodeIdentityEnvelope,
  type DeviceIdentityRecord,
} from "../envelope.js";
import { decodeEnrollmentReceipt, encodeEnrollmentReceipt } from "../receipt-envelope.js";

/** The subcommand that wipes a device identity. Deliberately verbose.
 *
 * DECLARED IN `desktop-invocation.ts` and re-exported here. Which argv means what is
 * a ROUTING concern, and the router must test for this flag; two declarations of the
 * same flag are two things to keep in step, which is the drift argued against for the
 * acknowledgement flag. Re-exported so every existing importer is unaffected. */
import { RESET_IDENTITY_FLAG, resolveDesktopInvocation } from "./desktop-invocation.js";
import { resolveSandboxProvider, type ProviderModuleLoader } from "./sandbox-provider.js";
import {
  authorizeControlCommand,
  executeControlCommand,
  readHostState,
  resolveTargetProcess,
  verifyControlToken,
  type ControlExecuteDeps,
} from "@armyofagents/worker-daemon";
import { readFileSync } from "node:fs";
import { resolveControlPaths } from "../control-paths.js";
import { createDesktopControlEffects } from "../control-effects.js";

// Re-exported so every existing importer of this module is unaffected by the move.
export { RESET_IDENTITY_FLAG };

/**
 * The second argument the wipe requires (plan §3/I7 point 4).
 *
 * Long and unpleasant to type ON PURPOSE. `--reset-identity` is what an operator
 * reaches for when a start fails, and on the same target the reset IS the
 * permanent lockout: the server denies the re-minted `workerId` as
 * `worker_transfer_denied` (`worker-enrollment.ts:418-423`) and
 * `findWorkerForBinding` carries no status predicate, so the stale row keeps
 * matching forever with no reset route. A one-argument path to that is a trap.
 */
export const RESET_ACKNOWLEDGEMENT_FLAG = "--i-understand-this-is-permanent";

export interface DesktopHostDeps {
  readonly env: Record<string, string | undefined>;
  readonly proc: ProcessLike;
  readonly platform: NodeJS.Platform | string;
  readonly argv: readonly string[];
  readonly createRunner?: () => CommandRunner;
  readonly bootstrap?: typeof bootstrapWorkerDaemon;
  readonly log?: (message: string) => void;
  /**
   * DEP-010 — the sandbox provider this root injects into the daemon.
   *
   * ★ ABSENT FOR THE SHIPPED BINARY. The default desktop boot passes none, and the
   * daemon then refuses to compose dispatch with `no_provider`. A provider arrives on
   * this seam ONLY when an operator opts in via `AOA_WORKER_SANDBOX_PROVIDER` (Step 7's
   * resolver builds it), and even then dispatch stays off by the flag. A directly-set
   * value here overrides the resolver, for tests and for an embedder that composes its
   * own; the shipped `bin/aoa-worker-desktop` never sets it.
   */
  readonly provider?: SandboxProvider;
  /**
   * DEP-010 — the provider-module loader the resolver uses. OPTIONAL; absent, the resolver's
   * default imports `@armyofagents/sandbox-e2b-provider` lazily. Injected by tests so the REAL
   * provider can be paired with a MOCK transport without the SDK's credential path.
   */
  readonly loadProviderModule?: ProviderModuleLoader;
  /**
   * DSK-003 — the outward effects a control command needs.
   *
   * OPTIONAL OVERRIDE, not a requirement: absent, the host builds the real ones from
   * `resolveControlPaths` + `createDesktopControlEffects`. An earlier revision refused
   * when this was missing, which was scaffolding for an unwired state that no longer
   * exists — a production binary must build its own effects, not decline to have any.
   *
   * `destroyIdentity` is deliberately NOT part of this: it is supplied by the host from
   * the stores it already built, so the receipt-before-identity ordering has exactly one
   * implementation rather than one per caller.
   */
  readonly control?: Omit<ControlExecuteDeps, "destroyIdentity">;
}

export async function runDesktopHost(deps: DesktopHostDeps): Promise<{ ok: boolean }> {
  const log = deps.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const runner = (deps.createRunner ?? (() => createCommandRunner()))();
  const bootstrap = deps.bootstrap ?? bootstrapWorkerDaemon;

  let refs;
  try {
    refs = resolveVaultRefs(deps.env, deps.platform);
  } catch (err) {
    // A location we cannot resolve is a refusal, never a guess: guessing is how a
    // device ends up with a second identity in a second place.
    log(`desktop host: ${(err as Error).message}`);
    deps.proc.exit(1);
    return { ok: false };
  }

  const identityStore = createOsRecordStore({
    runner,
    ref: refs.identity,
    platform: deps.platform,
    codec: { encode: encodeIdentityEnvelope, decode: decodeIdentityEnvelope },
  });
  const receiptStore = createOsRecordStore({
    runner,
    ref: refs.receipt,
    platform: deps.platform,
    codec: { encode: encodeEnrollmentReceipt, decode: decodeEnrollmentReceipt },
  });

  const invocation = resolveDesktopInvocation(deps.argv);

  // DSK-003 — a control command is handled HERE and returns. It must never fall through
  // to bootstrap: `aoa-worker-desktop status` starting a worker as a side effect would
  // give an operator checking on a running host a SECOND one.
  if (invocation.kind === "control") {
    // Build the real effects when none were injected. Constructing touches nothing:
    // `resolveControlPaths` is pure and the effects only reach the filesystem or the
    // loopback port when a command actually invokes them.
    const control = deps.control ?? buildRealControlDeps(deps.env, deps.platform);
    const result = await executeControlCommand(
      { command: invocation.command, token: invocation.token, argv: deps.argv },
      {
        ...control,
        // The receipt is cleared FIRST and the identity SECOND — the same order, and the
        // same reason, as the reset branch below: dying between them must leave an
        // identity with no receipt ("enrolled but unconfirmed", retryable) rather than a
        // receipt with no identity, which nothing can recover.
        destroyIdentity: async () => {
          receiptStore.clear();
          identityStore.clear();
        },
      },
    );
    if (!result.ok) {
      log(`desktop host: ${result.message}`);
      deps.proc.exit(1);
      return { ok: false };
    }
    log(`desktop host: ${result.command} ok${
      result.detail === undefined ? "" : ` ${JSON.stringify(result.detail)}`
    }`);
    return { ok: true };
  }

  // The ONLY `clear()` caller outside the control path, behind an explicit, guarded
  // subcommand.
  if (deps.argv.includes(RESET_IDENTITY_FLAG)) {
    // Read what is about to be destroyed BEFORE destroying it. A warning that
    // cannot name the identity is a warning an operator clicks through.
    let identity: DeviceIdentityRecord | null = null;
    let unreadable: string | null = null;
    try {
      identity = identityStore.load();
    } catch (err) {
      // A NARROW catch, and the reason it is safe here does NOT generalize.
      // `identity-store.ts` warns that the fail-closed property of a store fault
      // comes entirely from the throw being uncaught — nothing checks
      // `err.name` — so a broad catch around the ENROLLER would silently
      // reinstate the mint-a-second-identity bug (I3). This branch never mints,
      // never reaches the network, and turns the fault into a REFUSAL rather
      // than into a "no key" verdict. It is the strictest possible reading of
      // the failure, not a softening of it.
      unreadable = (err as Error).message;
    }

    // The one relaxation, and it rests on the single signal this package trusts:
    // `absent` arrives only through the platform's own ENOENT oracle and is never
    // inferred. With nothing stored there is provably nothing to make
    // unenrollable, and demanding the acknowledgement here would train operators
    // to paste it reflexively — which is how a guard stops being one.
    //
    // DEFERRED, deliberately: plan §3/I7 point 4 also relaxes for a G2(ii) crash
    // (identity slot PRESENT but zero-length, receipt absent). That state is not
    // distinguishable with the current outcome vocabulary — `ReadAllBytes` on a
    // zero-length blob yields an empty array, `Unprotect` throws, `harden` reports
    // exit 3, and the classifier says `locked`, exactly as it does for a genuinely
    // locked or ACL-denied slot holding a PERFECTLY GOOD key. Relaxing on `locked`
    // would drop the guard precisely where the lockout is real. Splitting the
    // vocabulary would take a distinct empty-slot exit code; that buys only a
    // friendlier message in one bricked state and is not worth a seventh outcome
    // kind on the package's most dangerous decision.
    const provablyAbsent = identity === null && unreadable === null;

    if (!provablyAbsent && !deps.argv.includes(RESET_ACKNOWLEDGEMENT_FLAG)) {
      const subject = identity
        ? `identity: workerId=${identity.workerId} targetId=${identity.targetId}`
        : `the identity slot could not be read (${unreadable}) — it may hold a working enrolment`;
      log(
        [
          "desktop host: REFUSING to reset the device identity. This is PERMANENT.",
          `  ${subject}`,
          "  Wiping the local key does NOT un-enrol this device. The server keeps the",
          "  worker bound to its target, denies any re-minted identity as",
          "  worker_transfer_denied, and the bound row keeps matching with no reset",
          "  route — so this machine can never enrol against that target again.",
          "  If a start is failing and an identity is present, do NOT reset: repair",
          "  the store or the OS profile instead.",
          `  To proceed anyway: ${RESET_IDENTITY_FLAG} ${RESET_ACKNOWLEDGEMENT_FLAG}`,
        ].join("\n"),
      );
      deps.proc.exit(1);
      return { ok: false };
    }

    // The receipt is cleared FIRST and the identity SECOND. That order matters: if
    // the process dies between them, the device is left holding an identity with no
    // receipt, which the coordinator treats as "enrolled but unconfirmed" and can
    // retry. The reverse order would leave a receipt with no identity — a state
    // claiming an enrolment whose key is gone, which nothing can recover.
    try {
      receiptStore.clear();
      identityStore.clear();
    } catch (err) {
      // A failed wipe must not report success: a half-wiped device that reports
      // "reset" is worse than one that reports a failure an operator can act on.
      log(`desktop host: identity reset FAILED: ${(err as Error).message}`);
      deps.proc.exit(1);
      return { ok: false };
    }
    log(
      provablyAbsent
        ? "desktop host: no device identity was stored; cleared any leftover enrollment receipt"
        : `desktop host: device identity reset${
            identity ? ` (workerId=${identity.workerId} targetId=${identity.targetId})` : ""
          }; this machine can no longer enrol against that target`,
    );
    return { ok: true };
  }

  // NO CAST. An earlier version wrote `as never` here, which erased a genuine
  // record-shape mismatch: the keystore's identity record was missing `v`,
  // `targetId` and `deviceGeneration`. The compiler had been reporting exactly
  // that and the cast silenced it. Keeping this call uncast makes the
  // type-checker the standing guard against the two shapes diverging again.
  // DSK-003 — the background host writes to its own file. Task Scheduler has no native
  // redirection, so without this every line on the only supported platform went nowhere.
  // DEP-010 — resolve a sandbox provider from the env and inject it, IMMEDIATELY BEFORE
  // bootstrap. Placed here, AFTER the control and reset branches (both returned above), so a
  // control command never spins up an SDK as a side effect and a reset never constructs a
  // provider. A directly-injected `deps.provider` wins (tests, embedders); otherwise the
  // resolver reads AOA_WORKER_SANDBOX_PROVIDER — unset ⇒ no provider, the shipped default. An
  // explicitly-requested provider that CANNOT be built is a REFUSAL to boot, never a degrade to
  // no-provider: the operator opted in, so honouring it silently as "off" would send them to
  // rebuild a build that is already correct.
  let provider = deps.provider;
  if (provider === undefined) {
    const resolution = await resolveSandboxProvider(deps.env, deps.loadProviderModule);
    if (resolution.kind === "refused") {
      log(`desktop host: sandbox provider requested but could not be built: ${resolution.reason}`);
      deps.proc.exit(1);
      return { ok: false };
    }
    if (resolution.kind === "provider") provider = resolution.provider;
  }

  const result: BootstrapResult = await bootstrap({
    env: deps.env,
    proc: deps.proc,
    identityStore,
    receiptStore,
    provider,
    logFilePath: resolveControlPaths(deps.env, deps.platform).logPath,
  });

  return { ok: result.ok };
}

/**
 * Compose the production control effects.
 *
 * Separate from `runDesktopHost` so the composition is readable on its own and so a test
 * can substitute the whole set. Everything it needs comes from `env`/`platform`, keeping
 * the "refuse rather than guess" rules of `resolveControlPaths` on the path.
 */
function buildRealControlDeps(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform | string,
): Omit<ControlExecuteDeps, "destroyIdentity"> {
  const paths = resolveControlPaths(env, platform);
  const effects = createDesktopControlEffects({
    paths,
    platform,
    kill: (pid, signal) => { process.kill(pid, signal as NodeJS.Signals); },
    fetchInstance: async (url) => (await fetch(url)).json() as Promise<{ instanceId?: string }>,
    readHostStateAt: () => readHostState(paths.statePath) as never,
    // The host opens this file itself, so `logs` now has a real target. `readFileSync`
    // throws when it does not exist yet, which `readLogTail` reports as "could not read"
    // rather than as an empty log — a distinction that matters on a first run.
    readLogFile: () => readFileSync(paths.logPath, "utf8"),
  });
  return {
    authorize: (command, token) =>
      authorizeControlCommand(command, token, {
        verify: (presented, d) => verifyControlToken(paths.tokenPath, presented, d),
      }),
    resolveTarget: async () =>
      resolveTargetProcess(paths.statePath, {
        probe: async (port) => (await fetch(`http://127.0.0.1:${port}/instance`)).json() as never,
      }) as never,
    signal: effects.signal,
    readStatus: effects.readStatus,
    readLogTail: effects.readLogTail,
  };
}
