import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runOrphanQuarantine } from "../lease/quarantine.js";

import type { FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker } from "./support/poll-fixtures.js";
import {
  FakeScheduler,
  RENEWAL_CODE,
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

describe("quarantine-grant-finalize — device-session grant → quarantined, against the fake plane", () => {
  it("grants a ≤5-min upload then finalizes to a non-promotable quarantined receipt", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);

    const outcome = await runOrphanQuarantine({
      client,
      session: staticSessionProvider(session),
      key,
      identity: quarantineIdentity(),
      artifact: quarantineArtifact(),
      reason: "late_output",
    });

    expect(outcome.status).toBe("quarantined");
    if (outcome.status !== "quarantined") throw new Error("expected quarantined");

    // Exactly one grant + one finalize traversed the device-session routes.
    expect(fake.quarantineGrantCount()).toBe(1);
    expect(fake.quarantineFinalizeCount()).toBe(1);

    // The only disposition is `quarantined` — there is NO promote/apply/select.
    expect(outcome.receipt.disposition).toBe("quarantined");
    expect(JSON.stringify(outcome.receipt)).not.toMatch(/"promote"|"apply"|"select"/i);

    // The recorded quarantine object sits under the distinct prefix.
    const records = fake.quarantineRecords();
    expect(records.map((r) => r.kind)).toEqual(["grant", "finalize"]);
    for (const record of records) {
      expect(record.quarantineObjectKey.startsWith("quarantine/organizations/")).toBe(true);
    }
  });

  it("surfaces a grant rejection without finalizing", async () => {
    const { session, key, client } = await enrollFixtureWorker(fake, RENEWAL_CODE);
    fake.enqueueQuarantineGrant({ kind: "rejected", reason: "unauthorized" });

    const outcome = await runOrphanQuarantine({
      client,
      session: staticSessionProvider(session),
      key,
      identity: quarantineIdentity(),
      artifact: quarantineArtifact(),
      reason: "late_output",
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("expected rejected");
    expect(outcome.stage).toBe("grant");
    expect(fake.quarantineFinalizeCount()).toBe(0); // never finalized
  });
});
