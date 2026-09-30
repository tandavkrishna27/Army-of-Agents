/**
 * Shared Human Operating Profile pick-lists. Consumed by BOTH the Human page
 * (HumanDetail) and the onboarding HumanProfileStep so the options can never
 * drift. Add new titles here — both surfaces pick them up.
 */
export const HUMAN_TITLE_OPTIONS = [
  "Founder",
  "Co-Founder",
  "Founder Partner",
  "Founder Operator",
  "CEO",
  "COO",
  "CTO",
  "CPO",
  "Chief of Staff",
  "General Manager",
  "Team Lead",
  "Product Lead",
  "Engineering Lead",
  "Design Lead",
  "Marketing Lead",
  "Sales Lead",
  "Customer Success Lead",
  "Operations Lead",
  "Finance Lead",
  "Legal Lead",
  "People Lead",
  "Product Manager",
  "Engineer",
  "Designer",
  "Researcher",
  "Analyst",
  "Operator",
  "Advisor",
] as const;

export const FALLBACK_TIMEZONE_OPTIONS = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Amsterdam",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

export function getTimezoneOptions(): string[] {
  const supported = Intl.supportedValuesOf?.("timeZone") ?? [];
  return Array.from(new Set(["UTC", ...FALLBACK_TIMEZONE_OPTIONS, ...supported])).sort((a, b) => a.localeCompare(b));
}

/**
 * Founder/team_lead/team_member role display labels. Shared by the Team
 * page's Humans tab (HumansTab) and anywhere else that surfaces a raw DB
 * role slug to a human — e.g. the invited-join terminal's "as Team Member"
 * copy. Unknown roles fall back to the raw slug at the call site.
 */
export const HUMAN_ROLE_LABELS: Record<string, string> = {
  founder: "Founder",
  team_lead: "Team Lead",
  team_member: "Team Member",
};
