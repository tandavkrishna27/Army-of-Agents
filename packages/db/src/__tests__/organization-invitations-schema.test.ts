import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = join(__dirname, "..", "schema", "organization_invitations.ts");
const INDEX_FILE = join(__dirname, "..", "schema", "index.ts");

describe("organization_invitations schema", () => {
  const src = readFileSync(SCHEMA_FILE, "utf8");
  const indexSrc = readFileSync(INDEX_FILE, "utf8");

  it("stores hash-only tokens with expiry (never plaintext)", () => {
    expect(src).toMatch(/pgTable\(\s*"organization_invitations"/);
    expect(src).toMatch(/tokenHash:\s*text\("token_hash"\)\.notNull\(\)/);
    expect(src).not.toMatch(/token:\s*text\("token"\)/); // no plaintext column
    expect(src).toMatch(/expiresAt:\s*timestamp\("expires_at",\s*\{\s*withTimezone:\s*true\s*\}\)\.notNull\(\)/);
    expect(src).toMatch(/acceptedAt:\s*timestamp\("accepted_at"/);
    expect(src).toMatch(/revokedAt:\s*timestamp\("revoked_at"/);
    expect(src).toMatch(/email:\s*text\("email"\)\.notNull\(\)/);
  });

  it("token_hash is globally unique", () => {
    expect(src).toMatch(/uniqueIndex\("organization_invitations_token_hash_uq"\)\.on\(table\.tokenHash\)/);
  });

  it("blocks duplicate live invites via a partial unique on pending (org,email)", () => {
    expect(src).toMatch(/uniqueIndex\("organization_invitations_pending_email_uq"\)[\s\S]*\.on\(table\.organizationId,\s*table\.email\)[\s\S]*\.where\(sql`status = 'pending'`\)/);
  });

  it("is exported from the schema barrel", () => {
    expect(indexSrc).toContain('export { organizationInvitations } from "./organization_invitations.js";');
  });
});
