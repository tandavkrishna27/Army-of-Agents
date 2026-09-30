// server/src/services/internal-agent/__tests__/conversation-output-refs.test.ts
import { describe, it, expect } from "vitest";
import { conversationService } from "../conversation.js";

// NOTE: legacy conversationService tests (sequence-mock style) live in
// server/src/__tests__/conversation-service.test.ts — extend THAT file for
// general appendMessage behavior; this file owns the outputRefs boundary.

function mockDb() {
  const captured: { values?: any } = {};
  const db = {
    insert: () => ({
      values: (v: any) => {
        captured.values = v;
        const chain: any = {
          onConflictDoNothing: () => chain,
          returning: () => ({
            then: (fn: any) => Promise.resolve(fn([{ id: "m1", ...v }])),
          }),
        };
        return chain;
      },
    }),
    // appendMessage calls: db.update(...).set({...}).where(...) — must be awaitable
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  } as any;
  return { db, captured };
}

const validRef = { v: 1, kind: "artifact", id: "a1", action: "created" };

describe("appendMessage outputRefs", () => {
  it("persists valid refs", async () => {
    const { db, captured } = mockDb();
    await conversationService(db).appendMessage("conv-1", {
      role: "assistant",
      content: "done",
      outputRefs: [validRef],
    });
    expect(captured.values.outputRefs).toEqual([
      expect.objectContaining({ id: "a1" }),
    ]);
  });

  it("drops invalid refs individually but still saves the message", async () => {
    const { db, captured } = mockDb();
    await conversationService(db).appendMessage("conv-1", {
      role: "assistant",
      content: "done",
      outputRefs: [{ v: 99, nope: true }, validRef],
    });
    expect(captured.values.outputRefs).toEqual([
      expect.objectContaining({ id: "a1" }),
    ]);
    expect(captured.values.content).toBe("done");
  });

  it("all-invalid refs → null", async () => {
    const { db, captured } = mockDb();
    await conversationService(db).appendMessage("conv-1", {
      role: "assistant",
      content: "done",
      outputRefs: [{ v: 99, nope: true }],
    });
    expect(captured.values.outputRefs).toBeNull();
  });

  it("null when absent", async () => {
    const { db, captured } = mockDb();
    await conversationService(db).appendMessage("conv-1", {
      role: "user",
      content: "hi",
    });
    expect(captured.values.outputRefs).toBeNull();
  });

  it("caps at 20 with created-first precedence and dedupes", async () => {
    const { db, captured } = mockDb();
    const referenced = Array.from({ length: 25 }, (_, i) => ({ v: 1, kind: "artifact", id: `r${i}`, action: "referenced" }));
    const created = [{ v: 1, kind: "artifact", id: "c1", action: "created" }];
    const dup = [{ v: 1, kind: "artifact", id: "r0", action: "referenced" }]; // duplicate of r0
    await conversationService(db).appendMessage("conv-1", {
      role: "assistant",
      content: "done",
      outputRefs: [...referenced, ...dup, ...created],
    });
    const persisted = captured.values.outputRefs as any[];
    expect(persisted).toHaveLength(20);
    expect(persisted.filter((r) => r.action === "created")).toHaveLength(1);
    expect(persisted.filter((r) => r.id === "r0")).toHaveLength(1); // deduped
  });

  it("persists a v:2 ref with provenance", async () => {
    const { db, captured } = mockDb();
    const v2ref = {
      v: 2, kind: "approval", id: "ap1", action: "referenced",
      provenance: { surface: "commander", entityId: "conv-1", seq: 1, emittedAt: "2026-07-18T10:00:00.000Z" },
    };
    await conversationService(db).appendMessage("conv-1", { role: "assistant", content: "done", outputRefs: [v2ref] });
    expect(captured.values.outputRefs).toEqual([expect.objectContaining({ v: 2, id: "ap1", kind: "approval" })]);
  });

  it("non-array outputRefs (string) → null, message saves", async () => {
    const { db, captured } = mockDb();
    await conversationService(db).appendMessage("conv-1", {
      role: "assistant",
      content: "done",
      outputRefs: '[{"v":1,"kind":"artifact","id":"a1","action":"created"}]',
    });
    expect(captured.values.outputRefs).toBeNull();
    expect(captured.values.content).toBe("done");
  });
});
