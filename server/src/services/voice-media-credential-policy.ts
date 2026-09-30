export type VoiceMediaCapability = "realtime_voice" | "media_generation";
type RestrictedSecret = {
  id: string;
  companyId: string;
  resolutionScope: string;
  status: string;
};
type RestrictedConnection = {
  id: string;
  companyId: string | null;
  secretRef: string | null;
  state: string;
  termsAttestedAt: Date | null;
  sharingPolicy: string;
  ownerUserId: string | null;
  config: Record<string, unknown>;
};
type RestrictedBinding = {
  companyId: string;
  secretId: string;
  targetType: string;
  targetId: string;
  configPath: string;
};
type RestrictedContext = {
  consumerType: string;
  consumerId: string;
  configPath?: string | null;
  actorType?: string;
  actorId?: string | null;
  voiceMedia?: { connectionId: string; capability: VoiceMediaCapability };
};
export type VoiceMediaCredentialDecision =
  | { allowed: true }
  | { allowed: false; reason: string };
export function authorizeVoiceMediaCredential(input: {
  secret: RestrictedSecret;
  connection: RestrictedConnection | null;
  binding: RestrictedBinding | null;
  context: RestrictedContext;
}): VoiceMediaCredentialDecision {
  const { secret, connection, binding, context } = input;
  const claim = context.voiceMedia;
  if (secret.resolutionScope !== "voice_media") return { allowed: true };
  if (secret.status !== "active")
    return { allowed: false, reason: "secret_inactive" };
  if (context.consumerType !== "provider_connection" || !claim)
    return { allowed: false, reason: "restricted_consumer" };
  const expectedPath = `voice_media.${claim.capability}`;
  if (!context.configPath || context.configPath !== expectedPath)
    return { allowed: false, reason: "restricted_path" };
  if (context.consumerId !== claim.connectionId)
    return { allowed: false, reason: "connection_claim_mismatch" };
  if (
    !connection ||
    connection.id !== claim.connectionId ||
    connection.companyId !== secret.companyId
  )
    return { allowed: false, reason: "connection_unavailable" };
  if (connection.secretRef !== secret.id)
    return { allowed: false, reason: "connection_secret_mismatch" };
  if (connection.state !== "verified" || !connection.termsAttestedAt)
    return { allowed: false, reason: "connection_not_ready" };
  const capabilities = Array.isArray(connection.config.voiceMediaCapabilities)
    ? connection.config.voiceMediaCapabilities
    : [];
  if (!capabilities.includes(claim.capability))
    return { allowed: false, reason: "capability_not_allowed" };
  if (
    connection.sharingPolicy === "owner_only" &&
    (context.actorType !== "user" || context.actorId !== connection.ownerUserId)
  )
    return { allowed: false, reason: "owner_required" };
  if (
    !binding ||
    binding.companyId !== secret.companyId ||
    binding.secretId !== secret.id ||
    binding.targetType !== "provider_connection" ||
    binding.targetId !== connection.id ||
    binding.configPath !== expectedPath
  )
    return { allowed: false, reason: "secret_unbound" };
  return { allowed: true };
}
