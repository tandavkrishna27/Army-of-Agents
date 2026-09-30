/**
 * AgentAvatar — shared small avatar for an agent.
 *
 * Renders a role-colored circle containing the default RobotIcon, OR the
 * custom image when an `avatarUrl` is passed. Extracted out of EntryRow so
 * both EntryRow (message cards) and PresenceStrip (working-agent chips) share
 * one source of truth for per-agent identity (DRY).
 *
 * The role color is derived from the agent name via `agentRoleColor` (also
 * exported here for callers that need the raw color, e.g. EntryRow's AgentCard
 * left border + role badge).
 */

/* ─── Agent role → color ─── */

export const ROLE_COLORS: Array<[RegExp, string]> = [
  [/scribe/i,     "#6470DC"],  // --data-indigo
  [/adjutant/i,   "#D9A938"],  // --data-amber
  [/router/i,     "#3FA8C7"],  // --data-teal
  [/planner/i,    "#5AA87E"],  // --data-emerald
  [/dispatcher/i, "#7E8AA8"],  // --data-slate
];

export function agentRoleColor(name: string | null | undefined): string {
  for (const [re, c] of ROLE_COLORS) if (re.test(name ?? "")) return c;
  return "#7E8AA8";
}

/* ─── Inline robot icon ─── */

export function RobotIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true">
      <rect x="3" y="9" width="14" height="9" rx="2" />
      <rect x="7" y="5.5" width="6" height="4" rx="1" />
      <line x1="10" y1="5.5" x2="10" y2="3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="2.2" r="1" />
      <circle cx="7.5" cy="13" r="1.3" />
      <circle cx="12.5" cy="13" r="1.3" />
      <rect x="8" y="16" width="4" height="1" rx="0.5" />
    </svg>
  );
}

/* ─── AgentAvatar ─── */

export interface AgentAvatarProps {
  name: string | null | undefined;
  avatarUrl?: string | null;
  /** Diameter in px. Default 32 (message cards); PresenceStrip uses ~20–24. */
  size?: number;
}

export function AgentAvatar({ name, avatarUrl, size = 32 }: AgentAvatarProps) {
  return (
    <div
      className="rounded-full flex items-center justify-center text-white shrink-0 overflow-hidden"
      style={{ background: agentRoleColor(name), width: size, height: size }}
      title={name ?? "Agent"}
      data-testid="agent-avatar"
    >
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={name ?? "Agent"}
          className="w-full h-full object-cover"
          data-testid="entry-agent-avatar"
        />
      ) : (
        <RobotIcon />
      )}
    </div>
  );
}
