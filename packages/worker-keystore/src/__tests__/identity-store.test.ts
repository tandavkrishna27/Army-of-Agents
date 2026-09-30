// DSK-001 / I2 + I4 — the command-driven DeviceIdentityStore.
//
// This is where the classifier's six outcomes become behaviour. Two invariants:
//
//   I2  Every outcome other than `present`/`absent` surfaces as a thrown
//       DeviceKeyStoreError. `load()` never returns a key it could not
//       authenticate, and — the part that matters — never returns `null` for a
//       fault, because `null` means NEVER ENROLLED to `loadOrCreateKey` and mints
//       a new identity the server will refuse forever.
//
//   I4  `saveIfAbsent` is compare-and-set. Two enrollers racing over one store
//       yield exactly one surviving envelope, so a device cannot end up with two
//       identities.
//
// The store takes an injected CommandRunner, so all of this is provable on the
// ubuntu-only required lane without a Windows host.

import { describe, expect, it, vi } from "vitest";
import { createOsIdentityStore, type CommandRunner } from "../identity-store.js";
import { encodeIdentityEnvelope, type DeviceIdentityRecord } from "../envelope.js";
import { STORE_SUCCESS_SENTINEL } from "../command-plan.js";
import type { StoreCommandResult } from "../outcome.js";

const REF = { blobPath: "C:\\AoA\\device-identity.v1.bin" };
const RECORD: DeviceIdentityRecord = {
  v: 1,
  workerId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  targetId: "a3000000-0000-4000-8000-000000000003",
  deviceGeneration: 1,
  privateKeyPkcs8Der: new Uint8Array([1, 2, 3, 4]),
};

/** A successful `store` now emits a positive sentinel; success is no longer
 * inferred from empty stdout. */
const stored = (): StoreCommandResult => ok(new TextEncoder().encode(STORE_SUCCESS_SENTINEL));

const ok = (stdout: Uint8Array): StoreCommandResult => ({
  exitCode: 0, signal: null, stdout, stderr: "", absenceSignalled: false,
});
const fault = (over: Partial<StoreCommandResult>): StoreCommandResult => ({
  exitCode: 1, signal: null, stdout: new Uint8Array(), stderr: "", absenceSignalled: false, ...over,
});
const absent = (): StoreCommandResult => ({
  exitCode: 1, signal: null, stdout: new Uint8Array(), stderr: "", absenceSignalled: true,
});

/** A runner scripted per operation, so each test states exactly what the OS said. */
function runnerOf(script: Partial<Record<string, StoreCommandResult>>): CommandRunner {
  return {
    run: (plan) => {
      const r = script[plan.stdin === "secret" ? "store" : plan.blobPath === REF.blobPath ? "load" : "other"];
      return r ?? fault({ stderr: "unscripted" });
    },
  };
}

const storeWith = (runner: CommandRunner) =>
  createOsIdentityStore({ runner, ref: REF, platform: "win32" });

describe("DSK-001/I2 — load() distinguishes absence from every fault", () => {
  it("returns null ONLY when the platform signalled absence", () => {
    const s = storeWith({ run: () => absent() });
    expect(s.load()).toBeNull();
  });

  it("returns the decoded record on a clean present", () => {
    const envelope = encodeIdentityEnvelope(RECORD);
    const s = storeWith({ run: () => ok(new TextEncoder().encode(Buffer.from(envelope).toString("base64"))) });
    const loaded = s.load();
    expect(loaded?.workerId).toBe(RECORD.workerId);
    expect(Array.from(loaded!.privateKeyPkcs8Der)).toEqual([1, 2, 3, 4]);
  });

  it("THROWS rather than returning null for every non-absent fault", () => {
    // The whole point of the six-valued outcome. Each of these, if softened to
    // null, mints a new device identity and locks the device out permanently.
    const faults: Array<[string, StoreCommandResult]> = [
      ["locked", fault({ exitCode: 3, stderr: "keychain is locked" })],
      ["denied", fault({ exitCode: 5, stderr: "Access is denied." })],
      ["corrupt (exit 0, empty stdout — the -File fail-open)", fault({ exitCode: 0 })],
      ["corrupt (generic non-zero — the -EncodedCommand shape)", fault({ exitCode: 1, stderr: "The data is invalid." })],
      ["unavailable (spawn failure)", fault({ exitCode: null, stderr: "spawn ENOENT" })],
      ["unavailable (killed)", fault({ exitCode: null, signal: "SIGKILL" })],
    ];
    for (const [name, result] of faults) {
      const s = storeWith({ run: () => result });
      expect(() => s.load(), name).toThrow();
    }
  });

  it("throws on a present-but-undecodable envelope — authenticated bytes, unusable record", () => {
    const s = storeWith({ run: () => ok(new TextEncoder().encode("bm90LWFuLWVudmVsb3Bl")) });
    expect(() => s.load()).toThrow(/envelope/i);
  });

  it("names DeviceKeyStoreError so the daemon's fail-closed handling applies", () => {
    const s = storeWith({ run: () => fault({ exitCode: 3 }) });
    try {
      s.load();
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).name).toBe("DeviceKeyStoreError");
    }
  });
});

describe("DSK-001/I4 — saveIfAbsent is compare-and-set", () => {
  it("reports stored on the first write", () => {
    const s = storeWith({ run: () => stored() });
    expect(s.saveIfAbsent(RECORD)).toBe("stored");
  });

  it("reports already_present when the OS refuses to overwrite", () => {
    // The plan uses an exclusive create, so an existing blob is an OS-level
    // refusal rather than a check-then-act race the store has to win.
    const s = storeWith({ run: () => fault({ exitCode: 4, stderr: "already exists" }) });
    expect(s.saveIfAbsent(RECORD)).toBe("already_present");
  });

  it("yields exactly ONE surviving envelope when two enrollers race", () => {
    // The concrete harm this prevents: two identities on one device, the second
    // of which the server denies permanently.
    let created = false;
    const runner: CommandRunner = {
      run: (plan) => {
        if (plan.stdin !== "secret") return absent();
        if (created) return fault({ exitCode: 4, stderr: "already exists" });
        created = true;
        return stored();
      },
    };
    const a = storeWith(runner);
    const b = storeWith(runner);
    const results = [a.saveIfAbsent(RECORD), b.saveIfAbsent({ ...RECORD, workerId: "other-worker-id" })];
    expect(results.filter((r) => r === "stored")).toHaveLength(1);
    expect(results.filter((r) => r === "already_present")).toHaveLength(1);
  });

  it("still THROWS on a genuine fault — a locked store is not already_present", () => {
    // Conflating "cannot write" with "someone else won" would silently drop an
    // enrollment and leave the device unenrolled while reporting success.
    const s = storeWith({ run: () => fault({ exitCode: 3, stderr: "locked" }) });
    expect(() => s.saveIfAbsent(RECORD)).toThrow();
  });

  it("feeds the record on stdin, never through the plan's argv", () => {
    const run = vi.fn(() => stored());
    const s = storeWith({ run });
    s.saveIfAbsent(RECORD);
    const [plan, stdin] = run.mock.calls[0] as unknown as [{ stdin: string; argv: string[] }, Uint8Array];
    expect(plan.stdin).toBe("secret");
    expect(stdin).toBeInstanceOf(Uint8Array);
    // The private key bytes must appear nowhere in argv.
    const argvJoined = plan.argv.join(" ");
    expect(argvJoined).not.toContain(Buffer.from(RECORD.privateKeyPkcs8Der).toString("base64"));
  });
});

describe("DSK-001 — clear()", () => {
  it("succeeds when the store had nothing", () => {
    const s = storeWith({ run: () => absent() });
    expect(() => s.clear()).not.toThrow();
  });

  it("throws on a fault, so a failed wipe is never reported as success", () => {
    const s = storeWith({ run: () => fault({ exitCode: 5, stderr: "Access is denied." }) });
    expect(() => s.clear()).toThrow();
  });
});

describe("DSK-001 — a store success must be positive, never inferred", () => {
  it("REJECTS a zero exit with no sentinel — silence is not proof of a write", () => {
    // This previously returned "stored". Inferring a successful write from an
    // ABSENCE of output is the same shape as inferring absence from empty
    // stdout, which is the defect this package exists to prevent.
    const s = storeWith({ run: () => ok(new Uint8Array()) });
    expect(() => s.saveIfAbsent(RECORD)).toThrow();
  });

  it("REJECTS a zero exit whose stdout is some OTHER string", () => {
    const s = storeWith({ run: () => ok(new TextEncoder().encode("something else")) });
    expect(() => s.saveIfAbsent(RECORD)).toThrow();
  });
});
