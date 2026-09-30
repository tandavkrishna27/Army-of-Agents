import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runOrphanQuarantine } from "../lease/quarantine.js";

import type { FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker } from "./support/poll-fixtures.js";
import {
  FakeScheduler,
  RENEWAL_CODE,
  controllableSessionProvider,
  quarantineArtifact,
  quarantineIdentity,
  staticSessionProvider,
  startRenewalPlane,
} from "./support/renewal-fixtures.js";

let scheduler: FakeScheduler;
let fake: FakeControlPlane;

beforeEach(async () => {
  scheduler = new FakeScheduler();
  fake = await startRenewalPlane(scheduler);
});
afterEach(async () => {
  await fake.close();
});

describe("quarantine-requires-device-session — survives lease loss, but the F007 session bound drops it", () => {
  it("quarantines with a LIVE device session (the lease is gone but the session authenticates)", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);

    // The lease has been lost; quarantine authenticates by the DEVICE session, not
    // the lease, so it still succeeds.
    const outcome = await runOrphanQuarantine({
      client,
      session: staticSessionProvider(session),
      key,
      identity: quarantineIdentity(),
      artifact: quarantineArtifact(),
      reason: "late_output",
    });

    expect(outcome.status).toBe("quarantined");
    expect(fake.quarantineGrantCount()).toBe(1);
  });

  it("DROPS orphan output when the session is terminal (E4-F007) — never the disabled commit path", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    const provider = controllableSessionProvider(session);
    provider.setTerminal(true);

    const grantsBefore = fake.quarantineGrantCount();
    const outcome = await runOrphanQuarantine({
      client,
      session: provider,
      key,
      identity: quarantineIdentity(),
      artifact: quarantineArtifact(),
      reason: "late_output",
    });

    expect(outcome.status).toBe("dropped");
    if (outcome.status !== "dropped") throw new Error("expected dropped");
    expect(outcome.cause).toBe("session_terminal");
    // Nothing was posted — not to quarantine, and certainly not to any commit path.
    expect(fake.quarantineGrantCount()).toBe(grantsBefore);
    expect(fake.quarantineFinalizeCount()).toBe(0);
  });
});
