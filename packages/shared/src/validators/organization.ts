import { z } from "zod";
import { ORGANIZATION_ROLES } from "../constants.js";

// Reject controls, format characters, and hard line separators that can reorder
// or hide an organization name. ZWNJ/ZWJ (U+200C/U+200D) remain allowed because
// they are meaningful in several writing systems; identity/authz use IDs.
const SAFE_ORGANIZATION_NAME_JOINERS = /[\u200C\u200D]/gu;
const UNSAFE_ORGANIZATION_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function containsUnsafeOrganizationNameCharacters(value: string): boolean {
  const withoutJoiners = value.replace(SAFE_ORGANIZATION_NAME_JOINERS, "");
  return (
    withoutJoiners.trim().length === 0 ||
    UNSAFE_ORGANIZATION_NAME_CHARACTERS.test(withoutJoiners)
  );
}

export const createOrganizationSchema = z.object({
  name: z
    .string()
    .refine(
      (value) => !containsUnsafeOrganizationNameCharacters(value),
      "name contains invalid or invisible characters",
    )
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(z.string().min(1).max(100)),
  creationRequestId: z.string().uuid().optional(),
}).strict();
export type CreateOrganization = z.infer<typeof createOrganizationSchema>;

export const inviteToOrganizationSchema = z.object({
  email: z.string().email(),
  role: z.enum(ORGANIZATION_ROLES).default("member"),
});
export type InviteToOrganization = z.infer<typeof inviteToOrganizationSchema>;
