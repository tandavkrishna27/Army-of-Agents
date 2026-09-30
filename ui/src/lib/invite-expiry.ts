const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Relative invite-expiry copy: "expires in 6 days" / "expires in 3 hours" /
 * "expires in 4 min" / "expired". Lowercase so it can be embedded in a
 * sentence; capitalize at the call site for standalone display.
 */
export function formatInviteExpiry(expiresAt: string | Date, now: Date = new Date()): string {
  const target = new Date(expiresAt).getTime();
  if (!Number.isFinite(target)) return "";
  const diffMs = target - now.getTime();
  if (diffMs <= 0) return "expired";
  if (diffMs < HOUR_MS) {
    const minutes = Math.ceil(diffMs / MINUTE_MS);
    return `expires in ${minutes} min`;
  }
  if (diffMs < 48 * HOUR_MS) {
    const hours = Math.round(diffMs / HOUR_MS);
    return `expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.round(diffMs / DAY_MS);
  return `expires in ${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * Belt-and-braces client-side normalization: the server now returns absolute
 * invite URLs, but if a relative path slips through (older server, proxies
 * stripping Host), prefix the current origin so the copied link still works.
 */
export function toAbsoluteInviteUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = window.location.origin.replace(/\/+$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}
