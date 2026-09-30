export function buildCliCommandLabel(): string {
  const args = process.argv.slice(2);
  // NOTE: this joins raw argv, which may include sensitive flags like --api-key <token> or
  // file paths containing usernames. If this function is used in contexts beyond `auth login`,
  // sanitize known option-value pairs before storing in the challenge record (max 240 chars).
  return args.length > 0 ? `aoa ${args.join(" ")}` : "aoa";
}
