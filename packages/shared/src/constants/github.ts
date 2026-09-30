/**
 * Canonical secret name used to store a company's GitHub Personal Access Token
 * in `company_secrets`. Shared so plugin SDK consumers and future integrations
 * can reference the same key without duplicating string literals.
 */
export const GITHUB_PAT_SECRET_NAME = "github_pat";

/**
 * Activity-log `action` kinds emitted by GitHub integration flows. Using
 * constants guards against typos at callsites and keeps the taxonomy greppable.
 */
export const GITHUB_PAT_ACTIVITY_KINDS = {
  CONNECTED: "github.pat.connected",
  DISCONNECTED: "github.pat.disconnected",
  PR_CREATED: "github.pr.created",
} as const;

export type GitHubPatActivityKind =
  (typeof GITHUB_PAT_ACTIVITY_KINDS)[keyof typeof GITHUB_PAT_ACTIVITY_KINDS];
