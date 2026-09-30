// CLI-008 Unit B — the worker-side staged-input resolver: pointer → DOWNLOAD GRANT.
//
// This is the middle link of the channel, and it needs its own test for the reason the build
// plan gives: a chain proven only at its ends is not proven. Break the grant mint and the
// end-to-end composition reds — but so does breaking the control-plane write, and so does
// breaking `writeFiles`. Only a test at THIS link can tell them apart.
//
// ★ The load-bearing cases are the refusals. The op answers HTTP 200 for `rejected` as well as
// for `download_granted` — the same fail-open trap `secret-redemption.ts` documents — so a
// status-only check would stage a run with no grants and report success.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { leaseOfferV1Schema } from "@armyofagents/worker-protocol";

import {
  STAGED_INPUT_EXTENSION_NAMESPACE,
  StagedInputUnavailableError,
  createStagedInputResolver,
  readStagedInputPointers,
  type StagedInputPointer,
} from "../lease/staged-input.js";
import { createSupervisor } from "../supervisor/supervisor.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { collectingSink, SUPERVISOR_IDENTITY } from "./support/supervisor-fixtures.js";
import { generateDeviceKey } from "../identity/device-key.js";
import type { WorkerSession } from "../enrollment/enroll.js";
import type { LeaseHandoff } from "../poll/poll-loop.js";
import { makeHandoff } from "./support/supervisor-fixtures.js";

const BODY = "# instructions\n";
const POINTER: StagedInputPointer = {
  artifactId: "00000000-0000-4000-8000-0000000000a1",
  path: "/home/user/.aoa/AGENTS.md",
  objectKey: "organizations/org-1/jobs/job-1/attempts/1/00000000-0000-4000-8000-0000000000a1",
  sha256: createHash("sha256").update(BODY).digest("hex"),
  sizeBytes: Buffer.byteLength(BODY),
};

/** The extension exactly as the control plane publishes it (an independent encoding of the
 * same shape — the two sides cannot import each other, and the server test pins that they
 * agree). */
function stagedInputExtension(pointers: readonly StagedInputPointer[]) {
  return {
    namespace: STAGED_INPUT_EXTENSION_NAMESPACE,
    schemaVersion: 1,
    critical: false,
    value: {
      files: pointers.map((p) => ({
        id: p.artifactId, path: p.path, key: p.objectKey, sha256: p.sha256, size: p.sizeBytes,
      })),
    },
  };
}

function handoffWith(pointers: readonly StagedInputPointer[]): LeaseHandoff {
  const base = makeHandoff();
  const offer = leaseOfferV1Schema.parse({
    ...base.offer,
    job: { ...base.offer.job, extensions: pointers.length > 0 ? [stagedInputExtension(pointers)] : [] },
  });
  return { ...base, offer };
}

const SESSION: WorkerSession = { token: "session-token", expiresAt: new Date(Date.now() + 600_000) } as never;

function downloadGrantFor(pointer: StagedInputPointer, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    operation: "download",
    artifactId: pointer.artifactId,
    method: "GET",
    url: "https://store.example/get?sig=abc",
    headers: {},
    issuedAt: "2026-09-03T12:00:00.000Z",
    expiresAt: "2026-09-03T12:05:00.000Z",
    maxBytes: pointer.sizeBytes,
    expectedSha256: pointer.sha256,
    objectKey: pointer.objectKey,
    redaction: "secret",
    ...overrides,
  };
}

/** A control-plane client double that answers with whatever the test scripts. */
function client(reply: (parsed: Record<string, unknown>) => { status: number; body: unknown }) {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    client: {
      artifactTransferGrantPath: "/api/worker-control/artifacts/transfer-grant",
      async artifactTransferGrant(request: { bytes: Buffer }) {
        const parsed = JSON.parse(request.bytes.toString("utf8")) as Record<string, unknown>;
        requests.push(parsed);
        return reply(parsed);
      },
    },
  };
}

function resolverOver(reply: Parameters<typeof client>[0]) {
  const c = client(reply);
  return {
    requests: c.requests,
    resolve: createStagedInputResolver({
      client: c.client as never,
      key: generateDeviceKey(),
      session: async () => SESSION,
    }),
  };
}

describe("CLI-008 Unit B — staged-input resolver (pointer → download grant)", () => {
  it("★ mints ONE download grant per pointer and pairs it with the in-sandbox path", async () => {
    const { resolve, requests } = resolverOver((parsed) => ({
      status: 200,
      body: {
        protocolVersion: 1,
        correlationId: parsed.correlationId,
        serverTime: "2026-09-03T12:00:00.000Z",
        outcome: "download_granted",
        grant: downloadGrantFor(POINTER),
      },
    }));
    const staged = await resolve({ handoff: handoffWith([POINTER]) });
    expect(staged).toHaveLength(1);
    expect(staged[0]!.path).toBe(POINTER.path);
    expect(staged[0]!.grant.objectKey).toBe(POINTER.objectKey);
    expect(staged[0]!.grant.operation).toBe("download");

    // The REQUEST is a download bound to this run's fence and this artifact.
    const body = requests[0]!.body as Record<string, unknown>;
    expect(body.operation).toBe("download");
    expect(body.artifactId).toBe(POINTER.artifactId);
    expect(body.expectedObjectKey).toBe(POINTER.objectKey);
    expect(body.expectedSha256).toBe(POINTER.sha256);
    expect(body.leaseId).toBe(handoffWith([POINTER]).leaseId);
  });

  it("★ NO POINTER ⇒ no request at all, and no staged files", async () => {
    // This is every production run today, and it must cost nothing.
    const { resolve, requests } = resolverOver(() => {
      throw new Error("must not be called");
    });
    expect(await resolve({ handoff: handoffWith([]) })).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("★ a `rejected` outcome on HTTP 200 FAILS — status is not success", async () => {
    const { resolve } = resolverOver((parsed) => ({
      status: 200,
      body: {
        protocolVersion: 1,
        correlationId: parsed.correlationId,
        serverTime: "2026-09-03T12:00:00.000Z",
        outcome: "rejected",
        reason: "malformed",
      },
    }));
    await expect(resolve({ handoff: handoffWith([POINTER]) })).rejects.toBeInstanceOf(
      StagedInputUnavailableError,
    );
  });

  it("★ a CROSS-PAIRED `upload_granted` FAILS — the frozen pairing rule is enforced", async () => {
    // A download request may only be answered by `download_granted` or `rejected`. Accepting
    // an upload grant here would hand the provider a PUT capability and call it an input.
    const { resolve } = resolverOver((parsed) => ({
      status: 200,
      body: {
        protocolVersion: 1,
        correlationId: parsed.correlationId,
        serverTime: "2026-09-03T12:00:00.000Z",
        outcome: "upload_granted",
        grant: { ...downloadGrantFor(POINTER), operation: "upload", method: "PUT" },
      },
    }));
    await expect(resolve({ handoff: handoffWith([POINTER]) })).rejects.toThrow(/upload_granted/);
  });

  it("★ a grant for a DIFFERENT object key FAILS", async () => {
    const { resolve } = resolverOver((parsed) => ({
      status: 200,
      body: {
        protocolVersion: 1,
        correlationId: parsed.correlationId,
        serverTime: "2026-09-03T12:00:00.000Z",
        outcome: "download_granted",
        grant: downloadGrantFor(POINTER, {
          objectKey: "organizations/org-1/jobs/job-1/attempts/1/somethingelse",
        }),
      },
    }));
    await expect(resolve({ handoff: handoffWith([POINTER]) })).rejects.toThrow(/different object key/);
  });

  it("a non-200 status FAILS", async () => {
    const { resolve } = resolverOver(() => ({ status: 503, body: {} }));
    await expect(resolve({ handoff: handoffWith([POINTER]) })).rejects.toThrow(/status 503/);
  });

  it("a malformed grant body FAILS rather than being passed to the provider", async () => {
    const { resolve } = resolverOver((parsed) => ({
      status: 200,
      body: {
        protocolVersion: 1,
        correlationId: parsed.correlationId,
        serverTime: "2026-09-03T12:00:00.000Z",
        outcome: "download_granted",
        grant: { operation: "download" },
      },
    }));
    await expect(resolve({ handoff: handoffWith([POINTER]) })).rejects.toThrow(/malformed grant/);
  });

  it("★ the idempotency key is DETERMINISTIC per (lease, artifact) — a retry is a replay", async () => {
    // The frozen `idempotencyKeySchema` is a uuid, so it cannot be a readable string — and a
    // RANDOM uuid would make every retry a fresh mint the control plane cannot recognise.
    const keys: unknown[] = [];
    const { resolve } = resolverOver((parsed) => {
      keys.push(parsed.idempotencyKey);
      return {
        status: 200,
        body: {
          protocolVersion: 1,
          correlationId: parsed.correlationId,
          serverTime: "2026-09-03T12:00:00.000Z",
          outcome: "download_granted",
          grant: downloadGrantFor(POINTER),
        },
      };
    });
    await resolve({ handoff: handoffWith([POINTER]) });
    await resolve({ handoff: handoffWith([POINTER]) });
    expect(keys[0]).toBe(keys[1]);
    expect(String(keys[0])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("reads back exactly what the control plane's encoding wrote", () => {
    expect(readStagedInputPointers([stagedInputExtension([POINTER])])).toEqual([POINTER]);
  });

  it("★ a CANCEL during staging is reported as CANCELLED, not as a staging failure", async () => {
    // A cancel withdraws effect authority and surfaces as a throw from `stageFiles`. Reporting
    // that as `stage_input_failed` would send someone hunting an object-store problem that
    // never existed — the same reasoning the execute arm already carries.
    const fake = createFakeSandboxProvider({});
    const sink = collectingSink();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      resolveStagedFiles: async () => {
        // Cancel lands while the resolve is in flight, then the resolve throws.
        await supervisor.cancel(makeHandoff().leaseId);
        throw new Error("resolve interrupted");
      },
    });
    await supervisor.accept(makeHandoff());
    const terminal = sink.events.find((event) => event.eventType === "terminal");
    expect(terminal?.payload).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
  });

  it("★ a PRESENT but UNREADABLE pointer fails the run — it does not read as 'nothing staged'", async () => {
    // Absent ⇒ []. Present-but-corrupt ⇒ throw. Collapsing the two would let an agent run
    // without the files the control plane meant it to have, with a clean terminal.
    const { resolve, requests } = resolverOver(() => {
      throw new Error("must not be called");
    });
    const damaged = {
      namespace: STAGED_INPUT_EXTENSION_NAMESPACE,
      schemaVersion: 1,
      critical: false,
      value: { files: [{ id: POINTER.artifactId, path: POINTER.path, key: POINTER.objectKey, sha256: "nope", size: 1 }] },
    };
    const base = makeHandoff();
    const handoff = {
      ...base,
      offer: leaseOfferV1Schema.parse({ ...base.offer, job: { ...base.offer.job, extensions: [damaged] } }),
    };
    await expect(resolve({ handoff })).rejects.toThrow(/unreadable/);
    expect(requests).toHaveLength(0);
  });
});
