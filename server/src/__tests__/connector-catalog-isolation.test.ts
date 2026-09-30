/**
 * @fileoverview Regression guard: connectors must NEVER become a
 * `MarketplaceItemTypeSchema` value.
 *
 * Connectors deliberately ship in their own `connectors.json`, not as a new
 * item type inside the existing marketplace `catalog.json`. The reason is a
 * fleet-wide availability hazard, not a style preference:
 *
 * `server/src/services/aoa-marketplace.ts` (`sync()`, ~line 107) runs a
 * whole-array `MarketplaceCatalogFileSchema.parse(json)` over the entire CDN
 * catalog. Zod's `z.array(...).parse` fails the ENTIRE parse if a single
 * element's `type` doesn't match the enum. If "connector" were added to
 * `MarketplaceItemTypeSchema` and the CDN catalog ever contained one
 * connector-typed item, every item in that catalog — including unrelated
 * skills, plugins, agents, and teams — would fail to parse.
 *
 * Worse, the catch block (~line 116) on a sync failure PRESERVES the
 * previously cached catalog rather than clearing it (by design, so a
 * transient CDN outage doesn't blank the marketplace). That means a bad
 * catalog wouldn't just fail once — every deployed AoA instance would
 * silently keep serving its last-known-good, pre-connector catalog forever,
 * with no user-visible error, because catalog sync happens on an unattended
 * background timer, not a user-triggered request.
 *
 * This was proven live against the real 514-item production catalog before
 * this decision was locked in. See Decision #116 / Plan 3a (curated
 * connector shelf) in docs/architecture/decisions.md.
 *
 * This test pins `MarketplaceItemTypeSchema`'s option list so that a future
 * "helpful" PR adding `"connector"` to the enum fails CI immediately instead
 * of surfacing as a silent production catalog freeze.
 */
import { describe, it, expect } from "vitest";
import { MarketplaceItemTypeSchema } from "@armyofagents/shared";

describe("connector catalog isolation (FU-14)", () => {
  it("does NOT add 'connector' to MarketplaceItemTypeSchema", () => {
    expect(MarketplaceItemTypeSchema.options).toEqual(["skill", "plugin", "agent", "team"]);
  });

  it("rejects an unknown item type, proving why the separate file is required", () => {
    expect(MarketplaceItemTypeSchema.safeParse("connector").success).toBe(false);
  });
});
