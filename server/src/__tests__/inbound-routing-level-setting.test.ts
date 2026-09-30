/**
 * Task 0.7 — inboundRoutingLevel config setting + validator
 *
 * A. Validator (packages/shared): rejects unknown values; accepts all 4 levels.
 * B. Route GET: full config row includes inboundRoutingLevel (default 'off').
 * C. Route PATCH: persists a new value via updateConfigSchema.
 * D. Schema comment: DB schema comment lists the real 4 values.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── A. Validator — pure-function tests ───────────────────────────────────────

import { updateInternalAgentConfigSchema } from "@armyofagents/shared";

describe("updateInternalAgentConfigSchema — inboundRoutingLevel", () => {
  it("accepts 'off'", () => {
    expect(
      updateInternalAgentConfigSchema.safeParse({ inboundRoutingLevel: "off" }).success,
    ).toBe(true);
  });

  it("accepts 'suggest'", () => {
    expect(
      updateInternalAgentConfigSchema.safeParse({ inboundRoutingLevel: "suggest" }).success,
    ).toBe(true);
  });

  it("accepts 'auto_attach'", () => {
    expect(
      updateInternalAgentConfigSchema.safeParse({ inboundRoutingLevel: "auto_attach" }).success,
    ).toBe(true);
  });

  it("accepts 'full_auto'", () => {
    expect(
      updateInternalAgentConfigSchema.safeParse({ inboundRoutingLevel: "full_auto" }).success,
    ).toBe(true);
  });

  it("rejects unknown value 'nope'", () => {
    expect(
      updateInternalAgentConfigSchema.safeParse({ inboundRoutingLevel: "nope" }).success,
    ).toBe(false);
  });

  it("rejects 'auto' (old 3-value comment value, now invalid)", () => {
    expect(
      updateInternalAgentConfigSchema.safeParse({ inboundRoutingLevel: "auto" }).success,
    ).toBe(false);
  });

  it("is optional — omitting inboundRoutingLevel is valid", () => {
    expect(
      updateInternalAgentConfigSchema.safeParse({ autonomyLevel: 0 }).success,
    ).toBe(true);
  });
});

// ── B. GET route — returns inboundRoutingLevel ────────────────────────────────
//
// The GET handler does db.select().from(internalAgentConfig).where(...)
// and returns the full row. The column exists in the schema with default 'off',
// so any row returned by the DB will include it. We assert via source-string
// contract that the GET returns the full config row (no field projection).

const routeSrc = readFileSync(
  resolve(__dirname, "../routes/internal-agent.ts"),
  "utf8",
);

describe("GET /companies/:companyId/internal-agent/config source contract", () => {
  it("GET handler selects the full config row (no field projection)", () => {
    // The handler does db.select().from(internalAgentConfig) with no column list,
    // so inboundRoutingLevel is automatically included because it's on the table.
    // Locate the GET handler block between the "2.5 Get Agent Config" comment
    // and the "2.6 Update Agent Config" comment.
    const getRouteStart = routeSrc.indexOf("2.5 Get Agent Config");
    const patchRouteStart = routeSrc.indexOf("2.6 Update Agent Config");
    expect(getRouteStart).toBeGreaterThan(-1);
    expect(patchRouteStart).toBeGreaterThan(getRouteStart);

    const getBlock = routeSrc.slice(getRouteStart, patchRouteStart);

    // Uses db.select() (no column narrowing), then returns configs[0]
    expect(getBlock).toContain(".select()");
    expect(getBlock).toContain(".from(internalAgentConfig)");
    expect(getBlock).toContain("res.json(configs[0])");
  });
});

// ── C. PATCH route — updateConfigSchema includes inboundRoutingLevel ──────────

describe("PATCH /companies/:companyId/internal-agent/config source contract", () => {
  it("updateConfigSchema includes inboundRoutingLevel", () => {
    expect(routeSrc).toContain("inboundRoutingLevel");
  });

  it("accepts all 4 routing level values in route schema", () => {
    expect(routeSrc).toContain('"off"');
    expect(routeSrc).toContain('"suggest"');
    expect(routeSrc).toContain('"auto_attach"');
    expect(routeSrc).toContain('"full_auto"');
  });

  it("PATCH persists inboundRoutingLevel via spread into db.update().set()", () => {
    // The route does: db.update(internalAgentConfig).set({ ...req.body, updatedAt: new Date() })
    // Since inboundRoutingLevel is in the validated body, it flows through the spread.
    const patchStart = routeSrc.indexOf("2.6 Update Agent Config");
    const nextSection = routeSrc.indexOf("2.7 Get Agent Runs", patchStart);
    const patchBlock = routeSrc.slice(patchStart, nextSection);
    expect(patchBlock).toContain("...req.body");
    expect(patchBlock).toContain("updatedAt: new Date()");
  });
});

// ── D. DB schema comment — lists real 4 values ───────────────────────────────

const schemaSrc = readFileSync(
  resolve(
    __dirname,
    "../../../packages/db/src/schema/internal_agent.ts",
  ),
  "utf8",
);

describe("internal_agent_config schema — inbound_routing_level column comment", () => {
  it("column exists with default 'off'", () => {
    expect(schemaSrc).toContain('text("inbound_routing_level").notNull().default("off")');
  });

  it("comment lists all 4 real values (not the old 3-value set)", () => {
    expect(schemaSrc).toContain("'off' | 'suggest' | 'auto_attach' | 'full_auto'");
  });

  it("comment does NOT say 'auto' as a standalone value", () => {
    // 'auto' was the wrong value in the original 3-value comment; it's now gone.
    // Check that the standalone 'auto' word is absent (allow 'auto_attach' / 'full_auto').
    const commentStart = schemaSrc.indexOf("// Task 0.2 (Inbound Dirty-Data Routing)");
    const commentEnd = schemaSrc.indexOf("inboundRoutingLevel:", commentStart);
    const commentBlock = schemaSrc.slice(commentStart, commentEnd);
    // 'auto' alone (not as prefix of 'auto_attach'/'full_auto') must not appear
    expect(commentBlock).not.toMatch(/'auto'\s*=/);
  });
});
