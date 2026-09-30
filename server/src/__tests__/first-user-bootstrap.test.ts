import { describe, it, expect } from "vitest";
import {
  promoteFirstUserToInstanceAdmin,
  shouldEnableHeadlessBootstrap,
} from "../services/first-user-bootstrap.js";

// Fake db exposing a transaction with a chainable select + capturable insert.
function makeDb(existingAdmins: unknown[]) {
  const inserted: Array<Record<string, unknown>> = [];
  const deleted: unknown[] = [];
  const lockCalls: unknown[] = [];
  const tx = {
    execute: async (arg: unknown) => {
      lockCalls.push(arg);
      return undefined;
    },
    select: () => ({ from: () => ({ where: async () => existingAdmins }) }),
    insert: () => ({ values: async (v: Record<string, unknown>) => { inserted.push(v); } }),
    delete: () => ({ where: async (condition: unknown) => { deleted.push(condition); } }),
  };
  const db = { transaction: async (fn: (t: typeof tx) => unknown) => await fn(tx) } as any;
  return { db, inserted, deleted, lockCalls };
}

describe("promoteFirstUserToInstanceAdmin (RB3/A7)", () => {
  it("promotes when NO instance_admin exists yet", async () => {
    const { db, inserted, lockCalls } = makeDb([]);
    const did = await promoteFirstUserToInstanceAdmin(db, "u1");
    expect(did).toBe(true);
    expect(inserted[0]).toMatchObject({ userId: "u1", role: "instance_admin" });
    expect(lockCalls.length).toBe(1); // advisory lock acquired inside the txn
  });

  it("does NOT promote when an instance_admin already exists", async () => {
    const { db, inserted } = makeDb([{ userId: "existing" }]);
    const did = await promoteFirstUserToInstanceAdmin(db, "u2");
    expect(did).toBe(false);
    expect(inserted.length).toBe(0);
  });

  it("replaces a lone synthetic local-board admin with the first real user", async () => {
    const { db, inserted, deleted } = makeDb([{ userId: "local-board" }]);
    const did = await promoteFirstUserToInstanceAdmin(db, "u1");
    expect(did).toBe(true);
    expect(inserted).toEqual([{ userId: "u1", role: "instance_admin" }]);
    expect(deleted).toHaveLength(1);
  });

  it("preserves local-board when the explicit headless claim gate is active", async () => {
    const { db, inserted, deleted } = makeDb([{ userId: "local-board" }]);
    const did = await promoteFirstUserToInstanceAdmin(db, "u1", {
      preserveSyntheticAdmin: true,
    });
    expect(did).toBe(false);
    expect(inserted).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  it("cleans up local-board when a real admin already exists", async () => {
    const { db, inserted, deleted } = makeDb([
      { userId: "local-board" },
      { userId: "existing" },
    ]);
    const did = await promoteFirstUserToInstanceAdmin(db, "existing");
    expect(did).toBe(false);
    expect(inserted).toHaveLength(0);
    expect(deleted).toHaveLength(1);
  });
});

describe("shouldEnableHeadlessBootstrap (A10/R16)", () => {
  it("false by default — the normal Google flow makes the first user admin", () => {
    expect(shouldEnableHeadlessBootstrap({ headlessBootstrap: false })).toBe(false);
  });

  it("true only when AOA_HEADLESS_BOOTSTRAP is set", () => {
    expect(shouldEnableHeadlessBootstrap({ headlessBootstrap: true })).toBe(true);
  });
});
