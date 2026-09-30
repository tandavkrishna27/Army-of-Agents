// -----------------------------------------------------------------------------
// DEP-012 Slice 3 · Wave β2 — the composition-root bin, fail-closed unit test
// (§β2.2.1 / §β2.4.2).
//
// The bin is the SOLE guard on the control-plane key. `createProviderServer`'s
// `controlPlanePublicKey?` is OPTIONAL — `undefined ⇒ an UNGATED server`, the exact
// cross-tenant `execute` hole B1 closed — so a bin that boots on a missing/empty/
// unreadable/unparseable/non-ed25519 key is a security defect, NOT a degraded mode.
// This proves EVERY fail-closed case REFUSES and `createProviderServer` is NEVER called,
// and the one happy path constructs the provider, loads+asserts the ed25519 key, and
// calls `createProviderServer` with the right options.
//
// ★ THE SEAM CUTS AT fs-BYTES (review B3): the loader + a file-BYTES reader + the env are
// injected, but the REAL `createPublicKey` runs on the injected bytes — so the
// unparseable / non-ed25519 / private-key refuse paths exercise the real parser, with NO
// real E2B key and NO real control-plane key (a locally-generated PEM stands in).
// -----------------------------------------------------------------------------

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { SandboxProvider } from "@armyofagents/worker-daemon";
import {
  bootAdapterManager,
  CONTROL_PLANE_PUBLIC_KEY_FILE_ENV,
  IDEMPOTENCY_LEDGER_DIR_ENV,
  PROVIDER_ENV,
  TEMPLATE_ENV,
  type AdapterManagerDeps,
  type ProviderModule,
} from "../bin/adapter-manager.js";
import { REAPER_ENABLED_ENV, REAPER_INTERVAL_MS_ENV, type ReaperScheduler, type ReaperTimer } from "../reaper-loop.js";
import { CONTROL_PLANE_URL_ENV } from "../reaper-truth-client.js";

// ── Locally-generated key material (no real control-plane key, no real E2B key) ──
const ed25519 = generateKeyPairSync("ed25519");
const ED25519_PUBLIC_PEM = ed25519.publicKey.export({ type: "spki", format: "pem" }) as string;
const ED25519_PRIVATE_PEM = ed25519.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RSA_PUBLIC_PEM = rsa.publicKey.export({ type: "spki", format: "pem" }) as string;

const KEY_PATH = "/keys/cp.pem";
const LEDGER_DIR = "/data/ledger";

/** A fake provider module: names E2bSandboxProvider + createRealE2bTransport WITHOUT the
 * real SDK (and without ever reading E2B_API_KEY). Records what it was handed. */
function fakeProviderModule() {
  const record: { transportCreated: number; ctorOptions?: { transport: unknown; templateId?: string } } = {
    transportCreated: 0,
  };
  const provider = { __fake: "provider" } as unknown as SandboxProvider;
  const mod: ProviderModule = {
    createRealE2bTransport: () => {
      record.transportCreated += 1;
      return { __fake: "transport" };
    },
    E2bSandboxProvider: class {
      constructor(options: { transport: unknown; templateId?: string }) {
        record.ctorOptions = options;
        return provider as unknown as object;
      }
    } as unknown as ProviderModule["E2bSandboxProvider"],
  };
  return { mod, record, provider };
}

/** Build injected deps around a spy `createProviderServer` + a byte-returning key reader. */
function makeDeps(over: Partial<AdapterManagerDeps> & { keyBytes?: Buffer | (() => Buffer) } = {}) {
  const listen = vi.fn();
  const server = { listen } as unknown as ReturnType<NonNullable<AdapterManagerDeps["createProviderServer"]>>;
  const createProviderServer = vi.fn(() => server);
  const { mod, record, provider } = fakeProviderModule();
  const keyBytes = over.keyBytes ?? Buffer.from(ED25519_PUBLIC_PEM);
  const readKeyFileBytes =
    over.readKeyFileBytes ?? vi.fn(() => (typeof keyBytes === "function" ? keyBytes() : keyBytes));
  const env: Record<string, string | undefined> = over.env ?? {
    [PROVIDER_ENV]: "e2b",
    [TEMPLATE_ENV]: "base",
    [CONTROL_PLANE_PUBLIC_KEY_FILE_ENV]: KEY_PATH,
    [IDEMPOTENCY_LEDGER_DIR_ENV]: LEDGER_DIR,
    PORT: "8090",
  };
  const deps: AdapterManagerDeps = {
    env,
    loadProviderModule: over.loadProviderModule ?? (async () => mod),
    readKeyFileBytes,
    createProviderServer,
    ...(over.reaperScheduler ? { reaperScheduler: over.reaperScheduler } : {}),
  };
  return { deps, createProviderServer, listen, record, provider, server };
}

describe("bootAdapterManager — the happy path", () => {
  it("constructs the real provider, loads+asserts the ed25519 key, and calls createProviderServer then listen", async () => {
    const { deps, createProviderServer, listen, record, provider } = makeDeps();
    const result = await bootAdapterManager(deps);

    expect(result.kind).toBe("listening");
    // The provider was built over the REAL transport (createRealE2bTransport was called).
    expect(record.transportCreated).toBe(1);
    expect(record.ctorOptions?.templateId).toBe("base");
    expect(createProviderServer).toHaveBeenCalledTimes(1);
    const opts = createProviderServer.mock.calls[0][0];
    expect(opts.provider).toBe(provider);
    expect(opts.idempotencyLedgerDir).toBe(LEDGER_DIR);
    // The control-plane key is a real ed25519 PUBLIC KeyObject.
    expect(opts.controlPlanePublicKey?.asymmetricKeyType).toBe("ed25519");
    expect(opts.controlPlanePublicKey?.type).toBe("public");
    // Gated server listens on the configured PORT.
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith("8090");
  });
});

describe("bootAdapterManager — fail-closed: createProviderServer is NEVER called", () => {
  const refuses = (label: string, mutate: (base: Record<string, string | undefined>) => Record<string, string | undefined>) =>
    it(label, async () => {
      const base = {
        [PROVIDER_ENV]: "e2b",
        [TEMPLATE_ENV]: "base",
        [CONTROL_PLANE_PUBLIC_KEY_FILE_ENV]: KEY_PATH,
        PORT: "8090",
      };
      const { deps, createProviderServer } = makeDeps({ env: mutate({ ...base }) });
      const result = await bootAdapterManager(deps);
      expect(result.kind).toBe("refused");
      expect(createProviderServer).not.toHaveBeenCalled();
    });

  refuses("provider env unset", (e) => {
    delete e[PROVIDER_ENV];
    return e;
  });
  refuses("provider env empty-string", (e) => ({ ...e, [PROVIDER_ENV]: "   " }));
  refuses("provider env 'none'", (e) => ({ ...e, [PROVIDER_ENV]: "none" }));
  refuses("provider env unrecognised", (e) => ({ ...e, [PROVIDER_ENV]: "docker" }));
  refuses("provider=e2b but template unset", (e) => {
    delete e[TEMPLATE_ENV];
    return e;
  });
  refuses("CP key path unset", (e) => {
    delete e[CONTROL_PLANE_PUBLIC_KEY_FILE_ENV];
    return e;
  });
  refuses("CP key path empty-string", (e) => ({ ...e, [CONTROL_PLANE_PUBLIC_KEY_FILE_ENV]: "   " }));

  it("CP key file missing (reader throws ENOENT)", async () => {
    const { deps, createProviderServer } = makeDeps({
      readKeyFileBytes: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    const result = await bootAdapterManager(deps);
    expect(result.kind).toBe("refused");
    expect(createProviderServer).not.toHaveBeenCalled();
  });

  it("CP key file unreadable (reader throws EACCES)", async () => {
    const { deps, createProviderServer } = makeDeps({
      readKeyFileBytes: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    const result = await bootAdapterManager(deps);
    expect(result.kind).toBe("refused");
    expect(createProviderServer).not.toHaveBeenCalled();
  });

  it("CP key readable-but-UNPARSEABLE (garbage bytes → real createPublicKey throws)", async () => {
    const { deps, createProviderServer } = makeDeps({ keyBytes: Buffer.from("-----BEGIN PUBLIC KEY-----\nnot base64\n-----END PUBLIC KEY-----\n") });
    const result = await bootAdapterManager(deps);
    expect(result.kind).toBe("refused");
    expect(createProviderServer).not.toHaveBeenCalled();
  });

  it("CP key empty buffer → real createPublicKey throws → refuse", async () => {
    const { deps, createProviderServer } = makeDeps({ keyBytes: Buffer.alloc(0) });
    const result = await bootAdapterManager(deps);
    expect(result.kind).toBe("refused");
    expect(createProviderServer).not.toHaveBeenCalled();
  });

  it("CP key parsed-but-non-ed25519 (RSA PEM) → refuse", async () => {
    const { deps, createProviderServer } = makeDeps({ keyBytes: Buffer.from(RSA_PUBLIC_PEM) });
    const result = await bootAdapterManager(deps);
    expect(result.kind).toBe("refused");
    expect(createProviderServer).not.toHaveBeenCalled();
  });

  it("CP key is a PRIVATE key PEM → refuse (key-hygiene: createPublicKey silently derives the public half)", async () => {
    const { deps, createProviderServer } = makeDeps({ keyBytes: Buffer.from(ED25519_PRIVATE_PEM) });
    const result = await bootAdapterManager(deps);
    expect(result.kind).toBe("refused");
    expect(createProviderServer).not.toHaveBeenCalled();
  });

  it("provider construct throws (e.g. the transport's missing-credential error) → refuse-not-degrade", async () => {
    const { deps, createProviderServer } = makeDeps({
      loadProviderModule: async () => ({
        createRealE2bTransport: () => {
          // The real transport throws synchronously when its credential is absent; the bin
          // must turn that into a refusal, never boot a degraded/ungated server.
          throw new Error("transport requires its provider-control credential");
        },
        E2bSandboxProvider: class {
          constructor() {
            /* unreached */
          }
        } as unknown as ProviderModule["E2bSandboxProvider"],
      }),
    });
    const result = await bootAdapterManager(deps);
    expect(result.kind).toBe("refused");
    expect(createProviderServer).not.toHaveBeenCalled();
  });
});

describe("bootAdapterManager — DEP-011 reaper wiring (Slice C, INERT until flagged)", () => {
  function fakeScheduler() {
    const scheduled: Array<() => void> = [];
    const scheduler: ReaperScheduler = {
      schedule(callback: () => void): ReaperTimer {
        scheduled.push(callback);
        return { cancel: () => {} };
      },
    };
    return { scheduler, scheduled };
  }

  it("flag OFF (default) — boots listening, /metrics counter is wired, the loop is NOT armed", async () => {
    const { scheduler, scheduled } = fakeScheduler();
    const { deps, createProviderServer, listen } = makeDeps({ reaperScheduler: scheduler });
    const result = await bootAdapterManager(deps);
    expect(result.kind).toBe("listening");
    expect(listen).toHaveBeenCalledTimes(1);
    // The shared metric counter is always created and handed to the server (renders zeros).
    expect(createProviderServer.mock.calls[0][0].reaperMetrics).toBeDefined();
    // No reaper flag ⇒ the loop is never armed.
    expect(scheduled).toHaveLength(0);
  });

  it("flag ON + control-plane URL — boots listening AND arms the loop (scheduler.schedule called)", async () => {
    const { scheduler, scheduled } = fakeScheduler();
    const env: Record<string, string | undefined> = {
      [PROVIDER_ENV]: "e2b",
      [TEMPLATE_ENV]: "base",
      [CONTROL_PLANE_PUBLIC_KEY_FILE_ENV]: KEY_PATH,
      PORT: "8090",
      [REAPER_ENABLED_ENV]: "1",
      [CONTROL_PLANE_URL_ENV]: "http://control-plane:8080",
      [REAPER_INTERVAL_MS_ENV]: "15000",
    };
    const { deps, createProviderServer } = makeDeps({ env, reaperScheduler: scheduler });
    const result = await bootAdapterManager(deps);
    expect(result.kind).toBe("listening");
    expect(createProviderServer).toHaveBeenCalledTimes(1);
    // The loop armed its first tick through the injected scheduler.
    expect(scheduled).toHaveLength(1);
  });

  it("flag ON but control-plane URL MISSING — REFUSES to boot (never a silently-dead reaper); server never starts", async () => {
    const { scheduler, scheduled } = fakeScheduler();
    const env: Record<string, string | undefined> = {
      [PROVIDER_ENV]: "e2b",
      [TEMPLATE_ENV]: "base",
      [CONTROL_PLANE_PUBLIC_KEY_FILE_ENV]: KEY_PATH,
      PORT: "8090",
      [REAPER_ENABLED_ENV]: "1",
      // CONTROL_PLANE_URL_ENV deliberately absent.
    };
    const { deps, createProviderServer, listen } = makeDeps({ env, reaperScheduler: scheduler });
    const result = await bootAdapterManager(deps);
    expect(result.kind).toBe("refused");
    // Refused BEFORE startServer/listen — no half-started host, no armed loop.
    expect(createProviderServer).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
  });
});
