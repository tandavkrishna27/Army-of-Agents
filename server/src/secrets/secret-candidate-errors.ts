export type SecretCandidateUnavailableCode =
  | "secret_missing"
  | "secret_inactive"
  | "secret_unbound"
  | "secret_version_missing"
  | "provider_config_disabled"
  | "aws_secret_not_found";

/**
 * A credential candidate that is locally unusable, while provider resolution
 * itself remains healthy. Only this error permits the resolver to try a lower
 * priority candidate or the legacy credential ladder.
 */
export class SecretCandidateUnavailableError extends Error {
  public readonly status: 404 | 422;
  public readonly expose = true;

  constructor(
    public readonly code: SecretCandidateUnavailableCode,
    message: string,
  ) {
    super(message);
    this.status = code === "secret_missing" || code === "secret_version_missing" ? 404 : 422;
    this.name = "SecretCandidateUnavailableError";
  }
}
