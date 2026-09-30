export { authorizeVoiceMediaCredential } from "./voice-media-credential-policy.js";
import type { VoiceMediaCapability } from "./voice-media-credential-policy.js";

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  companies,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  providerConnections,
} from "@armyofagents/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { insertActivityLog } from "./activity-log.js";

export function voiceMediaCredentialService(db: Db) {
  return {
    /** Creates the restricted secret, pending provider connection and exact
     * capability bindings in one transaction. Verification/attestation remain
     * separate governed transitions; until then common resolution denies. */
    async create(input: {
      companyId: string;
      name: string;
      value: string;
      provider: "openai" | "google" | "elevenlabs";
      capabilities: VoiceMediaCapability[];
      sharingPolicy: "owner_only" | "company_agents";
      ownerUserId?: string | null;
      createdByUserId: string;
    }) {
      if (!input.capabilities.length)
        throw unprocessable("At least one voice/media capability is required");
      const company = await db
        .select({ organizationId: companies.organizationId })
        .from(companies)
        .where(eq(companies.id, input.companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");
      const existing = await db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(
          and(
            eq(companySecrets.companyId, input.companyId),
            eq(companySecrets.name, input.name),
            isNull(companySecrets.deletedAt)
          )
        )
        .then((rows) => rows[0] ?? null);
      if (existing) throw conflict("Secret already exists");
      const key = input.name
        .trim()
        .replace(/[^A-Za-z0-9_]+/g, "_")
        .toUpperCase();
      const vault = getSecretProvider("local_encrypted");
      const prepared = await vault.createVersion({
        value: input.value,
        externalRef: null,
        providerConfig: null,
        context: {
          companyId: input.companyId,
          secretKey: key,
          secretName: input.name,
          version: 1,
        },
      });
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const secret = await txDb
          .insert(companySecrets)
          .values({
            companyId: input.companyId,
            organizationId: company.organizationId,
            name: input.name,
            key,
            status: "active",
            resolutionScope: "voice_media",
            managedMode: "aoa_managed",
            provider: "local_encrypted",
            providerMetadata: prepared.providerMetadata ?? null,
            externalRef: prepared.externalRef,
            latestVersion: 1,
            createdByUserId: input.createdByUserId,
          })
          .returning()
          .then((rows) => rows[0]);
        await txDb
          .insert(companySecretVersions)
          .values({
            secretId: secret.id,
            version: 1,
            material: prepared.material,
            providerVersionRef: prepared.providerVersionRef ?? null,
            status: "current",
            valueSha256: prepared.valueSha256,
            fingerprintSha256:
              prepared.fingerprintSha256 ?? prepared.valueSha256,
            createdByUserId: input.createdByUserId,
          });
        const connection = await txDb
          .insert(providerConnections)
          .values({
            organizationId: company.organizationId,
            companyId: input.companyId,
            provider: input.provider,
            authMethod: "api_key",
            ownerUserId: input.ownerUserId ?? null,
            secretRef: secret.id,
            state: "pending",
            sharingPolicy: input.sharingPolicy,
            config: {
              voiceMediaCapabilities: [...new Set(input.capabilities)],
            },
            createdByUserId: input.createdByUserId,
          })
          .returning()
          .then((rows) => rows[0]);
        await txDb
          .insert(companySecretBindings)
          .values(
            input.capabilities.map((capability) => ({
              companyId: input.companyId,
              secretId: secret.id,
              targetType: "provider_connection" as const,
              targetId: connection.id,
              configPath: `voice_media.${capability}`,
              versionSelector: "latest",
              required: true,
              label: "Voice/media credential",
            }))
          );
        await insertActivityLog(txDb, {
          companyId: input.companyId,
          actorType: "user",
          actorId: input.createdByUserId,
          action: "voice_media_credential.created",
          entityType: "provider_connection",
          entityId: connection.id,
          details: {
            provider: input.provider,
            capabilities: [...new Set(input.capabilities)],
            sharingPolicy: input.sharingPolicy,
          },
        });
        return { secret, connection };
      });
    },
  };
}
