import { describe, expect, it } from "vitest";
import { authorizeVoiceMediaCredential } from "../services/voice-media-credential-policy.js";

const base = {
  secret: {
    id: "secret-1",
    companyId: "company-1",
    resolutionScope: "voice_media" as const,
    status: "active",
  },
  connection: {
    id: "connection-1",
    companyId: "company-1",
    secretRef: "secret-1",
    state: "verified",
    termsAttestedAt: new Date(),
    sharingPolicy: "company_agents",
    ownerUserId: null,
    config: { voiceMediaCapabilities: ["realtime_voice"] },
  },
  binding: {
    companyId: "company-1",
    secretId: "secret-1",
    targetType: "provider_connection",
    targetId: "connection-1",
    configPath: "voice_media.realtime_voice",
  },
  context: {
    consumerType: "provider_connection" as const,
    consumerId: "connection-1",
    configPath: "voice_media.realtime_voice",
    actorType: "user" as const,
    actorId: "user-1",
    voiceMedia: {
      connectionId: "connection-1",
      capability: "realtime_voice" as const,
    },
  },
};

describe("voice/media restricted credential authorization", () => {
  it("admits a verified, attested and bound exact capability", () => {
    expect(authorizeVoiceMediaCredential(base)).toEqual({ allowed: true });
  });

  it.each([
    [
      "legacy system bypass",
      {
        context: {
          ...base.context,
          consumerType: "system",
          consumerId: "legacy",
        },
      },
    ],
    ["missing exact path", { context: { ...base.context, configPath: null } }],
    [
      "forged connection",
      { context: { ...base.context, consumerId: "connection-2" } },
    ],
    [
      "cross-company connection",
      { connection: { ...base.connection, companyId: "company-2" } },
    ],
    [
      "wrong secret",
      { connection: { ...base.connection, secretRef: "secret-2" } },
    ],
    [
      "revoked connection",
      { connection: { ...base.connection, state: "revoked" } },
    ],
    [
      "unattested terms",
      { connection: { ...base.connection, termsAttestedAt: null } },
    ],
    [
      "missing capability",
      {
        connection: {
          ...base.connection,
          config: { voiceMediaCapabilities: [] },
        },
      },
    ],
    ["deleted final binding", { binding: null }],
  ])("denies %s", (_label, patch) => {
    expect(
      authorizeVoiceMediaCredential({ ...base, ...patch } as never)
    ).toEqual(expect.objectContaining({ allowed: false }));
  });

  it("requires the owner for owner-only credentials", () => {
    expect(
      authorizeVoiceMediaCredential({
        ...base,
        connection: {
          ...base.connection,
          sharingPolicy: "owner_only",
          ownerUserId: "owner",
        },
      })
    ).toEqual(expect.objectContaining({ allowed: false }));
    expect(
      authorizeVoiceMediaCredential({
        ...base,
        connection: {
          ...base.connection,
          sharingPolicy: "owner_only",
          ownerUserId: "user-1",
        },
      })
    ).toEqual({ allowed: true });
  });
});
