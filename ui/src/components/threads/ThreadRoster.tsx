/**
 * ThreadRoster — static roster of thread_participants.
 *
 * Phase 1 Phase E batch 2 (Task T22): lists everyone who has been added to the
 * thread (humans + agents) with their role. Distinct from PresencePanel, which
 * shows who is *here right now / typing now*. Hidden when participants.length
 * === 0 so the OriginCard collapses to its previous footprint for fresh threads.
 *
 * Renders below PresencePanel inside OriginCard. Caller supplies the
 * `participants` rows so the component itself stays presentational —
 * matching the prop-passing pattern used for the existing presence strip.
 */

export interface ParticipantRow {
  /** "user" | "agent" — same enum as thread_participants.principalType */
  principalType: "user" | "agent";
  /** user id (text/uuid) OR agent id (uuid stored as text) */
  principalId: string;
  /** Human-readable display name (resolved by caller from auth_users / agents) */
  name: string;
  /** owner | co_owner | collaborator | viewer | worker */
  role: string;
  /** ISO timestamp */
  addedAt: string;
}

export function ThreadRoster({ participants }: { participants: ParticipantRow[] }) {
  if (participants.length === 0) return null;
  return (
    <div data-testid="thread-roster" className="mt-2 pt-2 border-t border-border text-xs">
      <div className="text-muted-foreground mb-1">
        Participants ({participants.length})
      </div>
      <div className="space-y-1">
        {participants.map((p) => (
          <div
            key={`${p.principalType}-${p.principalId}`}
            className="flex items-center gap-2"
            data-testid="thread-roster-row"
          >
            <span className="text-foreground">{p.name}</span>
            <span className="text-muted-foreground">({p.role})</span>
            <span className="text-muted-foreground ml-auto capitalize">
              {p.principalType}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
