// BRW-001 — artifact retention is mandatory (unit-shaped; runs on Windows, DEC-03).
//
// Acceptance: "bounded TTL and artifact retention are mandatory." Retention is modelled as
// a TOTAL FUNCTION of artifact kind, control-plane-owned, and never caller- or
// worker-supplied. Three reasons, in order:
//
//   1. MANDATORY MEANS NO ABSENT PATH. A total function over a closed enum cannot return
//      "unset". Per-job caller-chosen retention has a missing/null path by construction.
//   2. SECURITY. Letting a caller or a worker choose the retention of a
//      `browser_cookie_state` or `browser_storage_state` artifact is a privilege the threat
//      model must not grant.
//   3. It needs no storage, so it needs no migration and no schema coupling.
//
// `artifactManifestV1Schema.retention` is already a REQUIRED frozen field; this map is what
// makes a correct value always available to BRW-003 when it stamps manifests.
import { describe, expect, it } from "vitest";
import { ARTIFACT_KINDS, ARTIFACT_RETENTION_CLASSES } from "@armyofagents/worker-protocol";
import {
  BROWSER_ARTIFACT_KINDS,
  CREDENTIAL_BEARING_ARTIFACT_KINDS,
  browserArtifactRetention,
} from "../services/browser-artifact-retention.js";

describe("BRW-001 — retention is total over every frozen artifact kind", () => {
  // GUARD (mutation-tested): a new frozen artifact kind with no mapping fails here rather
  // than silently acquiring no retention. This is what makes "mandatory" structural.
  it("returns a valid retention class for every frozen artifact kind", () => {
    for (const kind of ARTIFACT_KINDS) {
      const retention = browserArtifactRetention(kind);
      expect(
        ARTIFACT_RETENTION_CLASSES as readonly string[],
        `${kind} must map to a frozen retention class`,
      ).toContain(retention);
    }
  });

  it("never returns undefined for any frozen artifact kind", () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(browserArtifactRetention(kind)).toBeDefined();
    }
  });
});

describe("BRW-001 — credential-bearing browser artifacts get the shortest retention", () => {
  // GUARD (mutation-tested): cookie and storage state carry live session credentials.
  // Anything longer than `ephemeral` keeps a usable credential on disk past the session.
  it("maps every credential-bearing kind to ephemeral", () => {
    for (const kind of CREDENTIAL_BEARING_ARTIFACT_KINDS) {
      expect(browserArtifactRetention(kind), `${kind} must be ephemeral`).toBe("ephemeral");
    }
  });

  it("includes browser cookie and storage state among the credential-bearing kinds", () => {
    expect(CREDENTIAL_BEARING_ARTIFACT_KINDS).toContain("browser_cookie_state");
    expect(CREDENTIAL_BEARING_ARTIFACT_KINDS).toContain("browser_storage_state");
  });

  it("never grants a credential-bearing kind an audit or checkpoint retention", () => {
    for (const kind of CREDENTIAL_BEARING_ARTIFACT_KINDS) {
      expect(browserArtifactRetention(kind)).not.toBe("audit");
      expect(browserArtifactRetention(kind)).not.toBe("checkpoint");
    }
  });
});

describe("BRW-001 — the browser artifact kinds are the frozen ones", () => {
  it("names every browser evidence kind the frozen protocol defines", () => {
    for (const expected of [
      "screenshot",
      "dom_snapshot",
      "browser_cookie_state",
      "browser_storage_state",
      "playwright_trace",
      "browser_video",
      "download",
    ]) {
      expect(BROWSER_ARTIFACT_KINDS).toContain(expected);
    }
  });

  it("claims no kind the frozen protocol does not define", () => {
    for (const kind of BROWSER_ARTIFACT_KINDS) {
      expect(ARTIFACT_KINDS as readonly string[]).toContain(kind);
    }
  });

  it("gives every browser evidence kind a retention", () => {
    for (const kind of BROWSER_ARTIFACT_KINDS) {
      expect(browserArtifactRetention(kind)).toBeTruthy();
    }
  });
});

describe("BRW-001 — an unknown kind fails safe, not open", () => {
  it("gives an unrecognised kind the shortest retention rather than the longest", () => {
    // Deliberately NO `as never` cast here. `browserArtifactRetention` accepts `string`
    // precisely because artifact kinds cross a JSON boundary and are not type-checked at
    // runtime; the exhaustiveness guard lives on the MAP (`satisfies Record<ArtifactKind,
    // ...>`), which is the thing that must be total. Casting a bad value through a narrower
    // signature would suppress the very check this test is here to exercise.
    const retention = browserArtifactRetention("not_a_real_kind");
    expect(retention).toBe("ephemeral");
  });

  it("fails safe for the empty string and for a prototype-pollution probe", () => {
    expect(browserArtifactRetention("")).toBe("ephemeral");
    expect(browserArtifactRetention("__proto__")).toBe("ephemeral");
    expect(browserArtifactRetention("constructor")).toBe("ephemeral");
  });
});
