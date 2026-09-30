import { EventEmitter } from "node:events";
import {
  agentApiKeys,
  agents,
  companies,
  companyMemberships,
  organizationMemberships,
} from "@armyofagents/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enforcePreviewSocketAuthorization,
  startPreviewSocketAuthorizationRevalidation,
} from "../services/preview-proxy.js";

function makeAuthorizationDb(input: {
  company?: Record<string, unknown> | null;
  orgMembership?: Record<string, unknown> | null;
  companyMembership?: Record<string, unknown> | null;
  key?: Record<string, unknown> | null;
  agent?: Record<string, unknown> | null;
  error?: Error;
}) {
  return {
    select: vi.fn(() => {
      if (input.error) throw input.error;
      let table: unknown;
      const chain = {
        from(nextTable: unknown) {
          table = nextTable;
          return chain;
        },
        where() {
          return chain;
        },
        then(resolve: (rows: unknown[]) => unknown) {
          const row = table === companies
            ? input.company
            : table === organizationMemberships
              ? input.orgMembership
              : table === companyMemberships
                ? input.companyMembership
                : table === agentApiKeys
                  ? input.key
                  : table === agents
                    ? input.agent
                    : null;
          return Promise.resolve(resolve(row ? [row] : []));
        },
      };
      return chain;
    }),
  };
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy = vi.fn((_error?: Error) => {
    this.destroyed = true;
    this.emit("close");
    return this;
  });
}

const boardActor = {
  companyId: "company-1",
  actorType: "board" as const,
  actorId: "user-1",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("preview open-socket authorization re-validation", () => {
  it("keeps an active cloud board membership connected", async () => {
    const db = makeAuthorizationDb({
      company: { organizationId: "org-1" },
      orgMembership: { id: "om-1" },
      companyMembership: { id: "cm-1" },
    });
    const socket = new FakeSocket();

    await expect(enforcePreviewSocketAuthorization(
      db as any,
      socket,
      boardActor,
      "cloud_auth",
    )).resolves.toBe(true);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it.each([
    ["organization membership", null, { id: "cm-1" }],
    ["company membership", { id: "om-1" }, null],
  ])("destroys the tunnel after %s revocation", async (_label, orgMembership, companyMembership) => {
    const db = makeAuthorizationDb({
      company: { organizationId: "org-1" },
      orgMembership,
      companyMembership,
    });
    const socket = new FakeSocket();

    await expect(enforcePreviewSocketAuthorization(
      db as any,
      socket,
      boardActor,
      "cloud_auth",
    )).resolves.toBe(false);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a re-validation query errors", async () => {
    const error = new Error("database unavailable");
    const db = makeAuthorizationDb({ error });
    const socket = new FakeSocket();
    const onError = vi.fn();

    await expect(enforcePreviewSocketAuthorization(
      db as any,
      socket,
      boardActor,
      "cloud_auth",
      onError,
    )).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(error);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not query cloud memberships for a non-cloud board socket", async () => {
    const db = makeAuthorizationDb({ error: new Error("must not query") });
    const socket = new FakeSocket();

    await expect(enforcePreviewSocketAuthorization(
      db as any,
      socket,
      boardActor,
      "authenticated",
    )).resolves.toBe(true);
    expect(db.select).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("revalidates the exact agent key and current agent eligibility", async () => {
    const activeDb = makeAuthorizationDb({
      key: { id: "key-1", companyId: "company-1", agentId: "agent-1", revokedAt: null },
      agent: { id: "agent-1", companyId: "company-1", status: "idle" },
    });
    const actor = {
      companyId: "company-1",
      actorType: "agent" as const,
      actorId: "agent-1",
      keyId: "key-1",
    };
    const activeSocket = new FakeSocket();

    await expect(enforcePreviewSocketAuthorization(
      activeDb as any,
      activeSocket,
      actor,
      "authenticated",
    )).resolves.toBe(true);

    const revokedDb = makeAuthorizationDb({
      key: { id: "key-2", companyId: "company-1", agentId: "agent-1", revokedAt: null },
      agent: { id: "agent-1", companyId: "company-1", status: "idle" },
    });
    const revokedSocket = new FakeSocket();
    await expect(enforcePreviewSocketAuthorization(
      revokedDb as any,
      revokedSocket,
      actor,
      "authenticated",
    )).resolves.toBe(false);
    expect(revokedSocket.destroy).toHaveBeenCalledTimes(1);
  });

  it("runs a bounded sweep and removes its timer after socket close", async () => {
    vi.useFakeTimers();
    const db = makeAuthorizationDb({
      company: { organizationId: "org-1" },
      orgMembership: { id: "om-1" },
      companyMembership: { id: "cm-1" },
    });
    const socket = new FakeSocket();
    startPreviewSocketAuthorizationRevalidation(
      db as any,
      socket,
      boardActor,
      "cloud_auth",
      30,
    );

    await vi.advanceTimersByTimeAsync(30);
    expect(db.select).toHaveBeenCalledTimes(3);
    socket.emit("close");
    await vi.advanceTimersByTimeAsync(90);
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it("does not retain a timer when the socket closed before registration", async () => {
    vi.useFakeTimers();
    const db = makeAuthorizationDb({ error: new Error("must not query") });
    const socket = new FakeSocket();
    socket.destroyed = true;

    startPreviewSocketAuthorizationRevalidation(
      db as any,
      socket,
      boardActor,
      "cloud_auth",
      30,
    );
    await vi.advanceTimersByTimeAsync(90);

    expect(vi.getTimerCount()).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });
});
