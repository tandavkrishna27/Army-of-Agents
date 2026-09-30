import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Shared contract between the playwright config (exports this path to the
 * webServer env as AOA_E2E_FAKE_CREW_CONTROL) and specs (rewrite before
 * triggering a crew turn). The server-side fake harness
 * (server/src/services/internal-agent/aoa-agents/fake-crew-llm.ts
 * readFakeCrewControl) reads it fresh on every fake turn. workers:1 +
 * reuseExistingServer:false make the single global file race-free.
 * Mirrors tests/e2e/helpers/fake-claude.ts.
 */
export const FAKE_CREW_CONTROL_PATH = path.join(
  os.tmpdir(),
  "aoa-e2e-fake-crew-control.json",
);

export interface FakeCrewControlFile {
  adjutant?: {
    mode?: "controller_scope";
    summary?: string;
    proposedTasks?: Array<{ title: string; assigneeRole?: string }>;
  };
}

/** Write (overwrite) the control file. */
export function writeFakeCrewControl(control: FakeCrewControlFile): void {
  fs.writeFileSync(FAKE_CREW_CONTROL_PATH, JSON.stringify(control), "utf8");
}

/** Remove the control file → the harness reverts to legacy behavior. */
export function resetFakeCrewControl(): void {
  try {
    fs.unlinkSync(FAKE_CREW_CONTROL_PATH);
  } catch {
    /* already absent */
  }
}
