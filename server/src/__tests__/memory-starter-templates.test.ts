/**
 * Phase 4 — Memory starter templates
 *
 * Verifies the static template data and the apply/idempotency logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MEMORY_STARTER_TEMPLATES,
  listStarterTemplates,
  getStarterTemplatesForFunctionType,
  applyStarterTemplate,
} from "../services/memory-starter-templates.js";

// ── Static data contracts ─────────────────────────────────────────────────────

describe("MEMORY_STARTER_TEMPLATES static data", () => {
  it("has exactly 11 templates", () => {
    expect(MEMORY_STARTER_TEMPLATES).toHaveLength(11);
  });

  it("every template has a unique id", () => {
    const ids = MEMORY_STARTER_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(11);
  });

  it("every template has at least 6 items", () => {
    for (const t of MEMORY_STARTER_TEMPLATES) {
      expect(t.items.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("every item has a non-empty title and content", () => {
    for (const t of MEMORY_STARTER_TEMPLATES) {
      for (const item of t.items) {
        expect(item.title.trim().length).toBeGreaterThan(0);
        expect(item.content.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("every item category is a valid MemoryItemCategory", () => {
    const VALID = ["preference", "procedure", "reference", "decision", "policy", "context", "insight"];
    for (const t of MEMORY_STARTER_TEMPLATES) {
      for (const item of t.items) {
        expect(VALID).toContain(item.category);
      }
    }
  });

  it("every template has a unique functionType (no accidental duplication)", () => {
    const types = MEMORY_STARTER_TEMPLATES.map((t) => t.functionType);
    expect(new Set(types).size).toBe(11);
  });

  it("listStarterTemplates returns the full array", () => {
    expect(listStarterTemplates()).toBe(MEMORY_STARTER_TEMPLATES);
  });

  it("resolves canonical department function types to existing starter templates", () => {
    expect(getStarterTemplatesForFunctionType("support").map((t) => t.id)).toContain("customer-support");
    expect(getStarterTemplatesForFunctionType("hr").map((t) => t.id)).toContain("people");
    expect(getStarterTemplatesForFunctionType("research").map((t) => t.id)).toContain("data");
    expect(getStarterTemplatesForFunctionType("software_development").map((t) => t.id)).toContain("engineering");
  });

  it("keeps legacy function type aliases compatible with canonical lookups", () => {
    expect(getStarterTemplatesForFunctionType("customer_support").map((t) => t.id)).toEqual(
      getStarterTemplatesForFunctionType("support").map((t) => t.id),
    );
    expect(getStarterTemplatesForFunctionType("people_ops").map((t) => t.id)).toEqual(
      getStarterTemplatesForFunctionType("hr").map((t) => t.id),
    );
  });
});

// ── applyStarterTemplate ──────────────────────────────────────────────────────

// Sequence-based mock DB (same pattern as memory-skill-sync.test.ts)
function makeDb(selectResults: unknown[], insertSpy?: ReturnType<typeof vi.fn>) {
  let selectCall = 0;
  const insert = insertSpy ?? vi.fn().mockResolvedValue([]);
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(selectResults[selectCall++] ?? [])),
      })),
    })),
    insert: vi.fn(() => ({
      values: insert,
    })),
  };
  return { db, insert };
}

describe("applyStarterTemplate", () => {
  it("throws for an unknown templateId", async () => {
    const { db } = makeDb([]);
    await expect(
      applyStarterTemplate(db as never, "co-1", "does-not-exist"),
    ).rejects.toThrow("Unknown starter template");
  });

  it("returns alreadyApplied=true when items already exist", async () => {
    // select returns count=3 (existing items)
    const { db, insert } = makeDb([[{ count: 3 }]]);
    const result = await applyStarterTemplate(db as never, "co-1", "engineering");
    expect(result.alreadyApplied).toBe(true);
    expect(result.count).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it("inserts all template items when count=0", async () => {
    const { db, insert } = makeDb([[{ count: 0 }]]);
    insert.mockResolvedValue([]);
    const result = await applyStarterTemplate(db as never, "co-1", "engineering");
    const template = MEMORY_STARTER_TEMPLATES.find((t) => t.id === "engineering")!;
    expect(result.alreadyApplied).toBe(false);
    expect(result.count).toBe(template.items.length);
    expect(insert).toHaveBeenCalledOnce();
    const rows = insert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(template.items.length);
  });

  it("sets correct metadata on inserted rows", async () => {
    const { db, insert } = makeDb([[{ count: 0 }]]);
    insert.mockResolvedValue([]);
    await applyStarterTemplate(db as never, "co-1", "marketing", { departmentId: "dept-1" });
    const rows = insert.mock.calls[0][0] as Array<Record<string, unknown>>;
    for (const row of rows) {
      expect(row.companyId).toBe("co-1");
      expect(row.status).toBe("approved");
      expect(row.source).toBe("template");
      expect(row.sourceContext).toBe("template:marketing");
      expect(row.layer).toBe("domain");
      expect(row.departmentId).toBe("dept-1");
    }
  });

  it("sets departmentId=null when no department is passed", async () => {
    const { db, insert } = makeDb([[{ count: 0 }]]);
    insert.mockResolvedValue([]);
    await applyStarterTemplate(db as never, "co-1", "sales");
    const rows = insert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows[0].departmentId).toBeNull();
  });
});
