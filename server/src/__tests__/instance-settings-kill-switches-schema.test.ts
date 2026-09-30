/**
 * REL-004 Lane C (D3/I3) — the kill-switch policy column cannot kill by default.
 *
 * Two properties, and the second is the one that would have hurt.
 *
 * 1. The document does NOT live in `instance_settings.general`.
 *    `instanceSettingsService.updateGeneral` rewrites that bag as
 *    `{ ...normalizeGeneralSettings(...), ...operationalMetadata }`, where the normalizer
 *    returns a FIXED four-field object and the metadata carve-out covers only
 *    `migrationSnapshots`. A `killSwitches` key in `general` is therefore deleted the next
 *    time anyone PATCHes instance settings — an operator throws a kill switch, someone
 *    toggles a checkbox in Settings, and the switch evaporates with no error.
 *
 * 2. The column is NULLABLE with NO default. A `DEFAULT '{}'::jsonb` would be a document that
 *    EXISTS and cannot be understood (`schema` is not 1), which `evaluateKillSwitches`
 *    correctly refuses — so the default alone would drain every fleet on every install. SQL
 *    NULL is the absent document, which is the permitted steady state.
 */

import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { instanceSettings } from "@armyofagents/db";

describe("REL-004 Lane C/I3 — instance_settings.kill_switches", () => {
  it("exists as a jsonb column named kill_switches", () => {
    const column = getTableColumns(instanceSettings).killSwitches;
    expect(column).toBeDefined();
    expect(column.name).toBe("kill_switches");
    expect(column.columnType).toBe("PgJsonb");
  });

  it("is NULLABLE with NO default — the default must not be a killing document", () => {
    const column = getTableColumns(instanceSettings).killSwitches;
    expect(column.notNull).toBe(false);
    expect(column.hasDefault).toBe(false);
  });

  it("is a column of its own, not a key inside the UI-owned general bag", () => {
    const columns = getTableColumns(instanceSettings);
    expect(Object.keys(columns)).toContain("killSwitches");
    // `general` and `experimental` stay exactly as they were; this change adds a field, it
    // does not repurpose one.
    expect(columns.general.name).toBe("general");
    expect(columns.experimental.name).toBe("experimental");
  });
});
