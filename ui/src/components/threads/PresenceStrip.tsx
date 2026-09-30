/* ════════════════════════════════════════════════════════════════════════
   PresenceStrip (Plan 7 + thread-chat-experience Phase 5, Task 5.3)

   Live human presence (stacked avatars, max 3 + "+N"), an agent "working"
   indicator that is VISUALLY DISTINCT from human presence (so founders can
   tell "Scout is researching" from "Maria is here"), and a subtle typing line.

   Lifted out of OriginCard so it can mount in the thread conversation view
   (ThreadTab) near the composer. OriginCard still imports it unchanged.

   Per working agent we render "<AgentName> is <activity>…" using the humanized
   `activity` the crew runner pushes through thread.presence (falls back to
   "typing" when absent), beside a PLACEHOLDER animated loader (a pulsing 3-dot
   row). The placeholder is intentional — the founder will provide the real
   loader asset (documented follow-up).

   A11y (D3): updates announce via aria-live="polite" — never assertive, so
   screen readers aren't spammed on every keystroke.
   ════════════════════════════════════════════════════════════════════════ */

import type { ThreadPresenceMember } from "../../context/LiveUpdatesProvider";
import { AgentAvatar } from "./AgentAvatar";

const MAX_VISIBLE_AVATARS = 3;

/** A working agent as consumed by the strip — `activity` is optional. */
export interface PresenceWorkingAgent {
  id: string;
  name: string;
  /** Humanized status (e.g. "researching"); defaults to "typing" when absent. */
  activity?: string;
}

/**
 * PLACEHOLDER typing loader — a simple pulsing 3-dot row.
 * TODO: replace with founder-provided loader asset (thread-chat-experience
 * follow-up — see plan Task 5.3 Step 6). Kept tiny + dependency-free on purpose.
 */
function TypingLoader() {
  return (
    /* TODO: replace with founder-provided loader asset */
    <span className="inline-flex items-center gap-0.5" aria-hidden="true" data-testid="presence-typing-loader">
      <span className="h-1 w-1 rounded-full bg-current animate-pulse [animation-delay:0ms]" />
      <span className="h-1 w-1 rounded-full bg-current animate-pulse [animation-delay:150ms]" />
      <span className="h-1 w-1 rounded-full bg-current animate-pulse [animation-delay:300ms]" />
    </span>
  );
}

export function PresenceStrip({
  presence,
  typingMembers,
  workingAgents,
}: {
  presence: ThreadPresenceMember[];
  typingMembers: ThreadPresenceMember[];
  workingAgents: PresenceWorkingAgent[];
}) {
  const hasAnything = presence.length > 0 || workingAgents.length > 0;
  if (!hasAnything) {
    // Keep a polite live region mounted so "everyone left" is announced once.
    return <div aria-live="polite" className="sr-only" data-testid="presence-live" />;
  }

  const visible = presence.slice(0, MAX_VISIBLE_AVATARS);
  const overflow = presence.length - visible.length;

  const typingLabel =
    typingMembers.length === 0
      ? null
      : typingMembers.length === 1
        ? "Someone is typing…"
        : `${typingMembers.length} people are typing…`;

  // Humanized per-agent activity line ("Scout is researching…"). When more than
  // two agents work at once we collapse to a count to keep the strip compact.
  const activityOf = (a: PresenceWorkingAgent) => a.activity || "typing";

  const announce = [
    presence.length > 0
      ? `${presence.length} ${presence.length === 1 ? "person" : "people"} here`
      : null,
    ...workingAgents.map((a) => `${a.name} is ${activityOf(a)}`),
    typingLabel,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <div className="flex flex-col gap-1" data-testid="presence-strip">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Human presence avatars */}
        {visible.length > 0 && (
          <div className="flex items-center -space-x-1.5" aria-hidden="true">
            {visible.map((m) => (
              // No display-name source is available in this component (presence
              // carries only userId). getInitials on a raw UUID produces garbage
              // fragments ("C3"), so render a neutral placeholder instead and
              // avoid leaking the UUID via the tooltip.
              <span
                key={m.userId}
                title="Member here"
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-background bg-muted text-[9px] font-semibold text-muted-foreground"
              >
                ?
              </span>
            ))}
            {overflow > 0 && (
              <span
                title={`${overflow} more`}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-background bg-muted/70 text-[9px] font-semibold text-muted-foreground"
              >
                +{overflow}
              </span>
            )}
          </div>
        )}

        {/* Agent "working" indicator — a per-agent default avatar carries the
            identity (not a color badge), beside humanized activity + the
            placeholder loader. Up to 2 agents shown individually; 3+ collapses
            to a compact avatar stack + count. */}
        {workingAgents.length > 0 && workingAgents.length <= 2 ? (
          workingAgents.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
              data-testid="agent-working-indicator"
              title={`${a.name} is ${activityOf(a)}`}
            >
              <AgentAvatar name={a.name} size={20} />
              <span>
                {a.name} is {activityOf(a)}…
              </span>
              <TypingLoader />
            </span>
          ))
        ) : workingAgents.length > 2 ? (
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
            data-testid="agent-working-indicator"
            title={workingAgents.map((a) => `${a.name} is ${activityOf(a)}`).join(", ")}
          >
            <span className="flex items-center -space-x-1.5">
              {workingAgents.slice(0, 3).map((a) => (
                <AgentAvatar key={a.id} name={a.name} size={20} />
              ))}
            </span>
            <span>{workingAgents.length} agents working…</span>
            <TypingLoader />
          </span>
        ) : null}
      </div>

      {/* Typing line — subtle */}
      {typingLabel && (
        <span className="text-[11px] italic text-muted-foreground" data-testid="typing-indicator">
          {typingLabel}
        </span>
      )}

      {/* Polite a11y announcement (never assertive). */}
      <div aria-live="polite" className="sr-only" data-testid="presence-live">
        {announce}
      </div>
    </div>
  );
}
