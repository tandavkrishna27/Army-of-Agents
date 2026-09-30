/**
 * GitHub repo URL validator (WS4 prereq). Extracted from `NewProjectDialog`'s
 * function-local `isGitHubRepoUrl` (Codex P2 — it needed to be shared so
 * onboarding's Departments surface could reuse the exact same rule). Accepts
 * `https://github.com/<owner>/<repo>` (and `www.github.com`); rejects any
 * other host, malformed URLs, and URLs with fewer than two path segments.
 */
export function isGitHubRepoUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.length >= 2;
  } catch {
    return false;
  }
}
