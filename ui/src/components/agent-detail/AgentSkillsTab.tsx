import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import type { CompanySkillListItem } from "@armyofagents/shared";
import { cn } from "@/lib/utils";
import { agentsApi } from "../../api/agents";
import { companySkillsApi } from "../../api/companySkills";
import { queryKeys } from "../../lib/queryKeys";
import { PageSkeleton } from "../PageSkeleton";
import { ApiError } from "../../api/client";
import { useToast } from "@/context/ToastContext";

/**
 * Shared Skills tab for both the worker (AgentDetail) and AoA (AoaAgentDetail)
 * pages. Grouped Attached/Available toggle rows + search; immediate per-toggle
 * commit with optimistic update + rollback on failure; resync on prop change.
 */
export function AgentSkillsTab({
  agentId,
  companyId,
  skillKeys: initialSkillKeys,
  skillsRoute = "/skills",
  expectedUpdatedAt,
}: {
  agentId: string;
  companyId: string;
  skillKeys: string[];
  /** Route to the company skills page (varies by page chrome). */
  skillsRoute?: string;
  /**
   * Optimistic-concurrency token (the agent row's `updatedAt`, ISO string).
   * When provided, each skill PATCH is guarded against concurrent edits and a
   * 409 surfaces a "changed elsewhere" toast. When omitted, the save is
   * last-write-wins (back-compat — and the payload omits the token).
   */
  expectedUpdatedAt?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [localKeys, setLocalKeys] = useState<string[]>(initialSkillKeys);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Freshest server-known attached set, tracked even while a toggle is in
  // flight, so a failed PATCH can roll back to it rather than to a pre-toggle
  // snapshot that a mid-save refetch may have superseded.
  const latestSkillKeys = useRef(initialSkillKeys);
  useEffect(() => {
    latestSkillKeys.current = initialSkillKeys;
  }, [initialSkillKeys]);

  // Freshest optimistic-concurrency token. Like `latestSkillKeys`, this is
  // advanced from the SUCCESSFUL update response so a second toggle fired before
  // the post-success refetch lands sends the up-to-date token (not the stale prop)
  // and doesn't self-409 against this component's own prior write. (Decision #104)
  const latestExpectedUpdatedAt = useRef(expectedUpdatedAt);
  useEffect(() => {
    latestExpectedUpdatedAt.current = expectedUpdatedAt;
  }, [expectedUpdatedAt]);

  // Resync when the agent refetches / navigation changes the attached set —
  // but never while a toggle is in flight, or an unrelated refetch landing
  // mid-save would clobber the optimistic state. The post-save invalidate
  // refetches and resyncs once pendingKey clears.
  useEffect(() => {
    if (pendingKey !== null) return;
    setLocalKeys(initialSkillKeys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSkillKeys]);

  const { data: allSkills, isLoading } = useQuery({
    queryKey: queryKeys.companySkills.list(companyId),
    queryFn: () => companySkillsApi.list(companyId),
    enabled: Boolean(companyId),
  });

  async function handleToggle(skillKey: string) {
    const prev = localKeys;
    // Build the payload from in-library keys only. The server's resolveSkillKeys
    // rejects ANY unknown key, so an orphaned key (deleted from the library) in the
    // array would 422 the whole save. Excluding them means every toggle — attach,
    // detach, or removing an orphan — also clears all orphans in one valid request.
    const library = new Set((allSkills ?? []).map((s) => s.key));
    const validAttached = prev.filter((k) => library.has(k));
    const next = validAttached.includes(skillKey)
      ? validAttached.filter((k) => k !== skillKey)
      : library.has(skillKey)
        ? [...validAttached, skillKey]
        : validAttached;
    setLocalKeys(next);
    setPendingKey(skillKey);
    setError(null);
    try {
      const payload: Record<string, unknown> = { skillKeys: next };
      // Send the FRESHEST token (ref), not the prop — guards against a second
      // toggle that fires before the post-success refetch updates the prop.
      const tokenToSend = latestExpectedUpdatedAt.current;
      if (tokenToSend) payload.expectedUpdatedAt = tokenToSend;
      const updatedAgent = await agentsApi.update(agentId, payload as never);
      // Advance the rollback baseline to the just-confirmed set, so a later toggle
      // that fails before this save's refetch lands rolls back to here (keeping this
      // change) rather than to the now-stale initial prop value.
      latestSkillKeys.current = next;
      // Advance the token from the server's response so the NEXT toggle (which may
      // fire before the invalidate refetch lands) guards against the value we just
      // wrote — not the stale prop. `updatedAt` arrives as a Date or ISO string;
      // normalize to ISO. Only advance when the prop-driven token feature is active.
      if (
        latestExpectedUpdatedAt.current &&
        (updatedAgent as { updatedAt?: string | Date } | undefined)?.updatedAt
      ) {
        latestExpectedUpdatedAt.current = new Date(
          (updatedAgent as { updatedAt: string | Date }).updatedAt,
        ).toISOString();
      }
      // Invalidate the detail PREFIX so both the uuid- and urlKey-keyed agent queries
      // refetch — the worker page may be opened by urlKey.
      void queryClient.invalidateQueries({ queryKey: ["agents", "detail"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) });
    } catch (e) {
      // Failed PATCH must not leave the optimistic change in place. Roll back to
      // the freshest server-known set (not the pre-toggle snapshot) so a change
      // that landed while this toggle was in flight isn't lost.
      setLocalKeys(latestSkillKeys.current);
      if (e instanceof ApiError && e.status === 409) {
        // Concurrent edit: the agent changed under us. Refetch + tell the user
        // to redo their toggle against the reloaded state (Decision #104).
        void queryClient.invalidateQueries({ queryKey: ["agents", "detail"] });
        pushToast({
          title: "This agent changed elsewhere",
          body: "Reloaded the latest version — please redo your change.",
          tone: "error",
        });
      } else {
        setError(e instanceof Error ? e.message : "Failed to update skills");
      }
    } finally {
      setPendingKey(null);
    }
  }

  if (isLoading) return <PageSkeleton variant="list" />;

  const q = query.trim().toLowerCase();
  const skills = allSkills ?? [];
  const libraryKeys = new Set(skills.map((s) => s.key));
  // Attached keys whose company skill no longer exists in the library. They'd
  // otherwise be invisible (in neither list) yet still ride along in every PATCH,
  // so surface them in Attached with a way to remove them — computed before the
  // empty-library early return so an empty library can't hide them.
  const orphanKeys = localKeys.filter(
    (k) => !libraryKeys.has(k) && (!q || k.toLowerCase().includes(q)),
  );

  // Only the bare empty state when there's nothing to show at all (no library
  // skills AND no orphaned keys to remove).
  if (skills.length === 0 && orphanKeys.length === 0) {
    return (
      <div className="px-6 py-10 text-center text-sm text-muted-foreground">
        No skills available.{" "}
        <Link to={skillsRoute} className="underline">
          Create or import skills
        </Link>{" "}
        first.
      </div>
    );
  }

  const matches = (s: CompanySkillListItem) =>
    !q ||
    s.name.toLowerCase().includes(q) ||
    s.key.toLowerCase().includes(q) ||
    (s.description ?? "").toLowerCase().includes(q);
  const filtered = skills.filter(matches);
  const attached = filtered.filter((s) => localKeys.includes(s.key));
  const available = filtered.filter((s) => !localKeys.includes(s.key));

  // While any toggle's PATCH is in flight, lock every row. Each request sends the
  // full skillKeys array and the server overwrites wholesale (last-write-wins), so
  // overlapping toggles could resolve out of order and silently drop a change.
  // Serializing to one in-flight update at a time makes that impossible.
  const busy = pendingKey !== null;

  const renderRow = (skill: CompanySkillListItem) => {
    const isAttached = localKeys.includes(skill.key);
    const updating = pendingKey === skill.key;
    return (
      <div
        key={skill.id}
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-pressed={isAttached}
        aria-disabled={busy}
        onClick={() => { if (!busy) handleToggle(skill.key); }}
        onKeyDown={(e) => { if (!busy && (e.key === " " || e.key === "Enter")) { e.preventDefault(); handleToggle(skill.key); } }}
        className={cn(
          "flex items-center gap-3 px-3.5 py-3 border-b border-border last:border-b-0 transition-colors",
          updating ? "opacity-60 cursor-wait" : busy ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-accent/20",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{skill.name}</span>
            {skill.trustLevel && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                {skill.trustLevel}
              </span>
            )}
            {skill.sourceLabel && (
              <span className="text-[10px] text-muted-foreground">{skill.sourceLabel}</span>
            )}
          </div>
          {skill.description && (
            <div className="text-xs text-muted-foreground mt-0.5 truncate">{skill.description}</div>
          )}
          <div className="text-[11px] text-muted-foreground mt-0.5 font-mono">{skill.key}</div>
        </div>
        <div
          className={cn(
            "relative w-9 h-5 rounded-full shrink-0 transition-colors",
            isAttached ? "bg-green-500" : "bg-border",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
              isAttached ? "right-0.5" : "left-0.5",
            )}
          />
        </div>
      </div>
    );
  };

  // Attached key with no matching library skill — render by key with a remove toggle.
  const renderOrphanRow = (key: string) => {
    const updating = pendingKey === key;
    return (
      <div
        key={`orphan:${key}`}
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-pressed
        aria-disabled={busy}
        onClick={() => { if (!busy) handleToggle(key); }}
        onKeyDown={(e) => { if (!busy && (e.key === " " || e.key === "Enter")) { e.preventDefault(); handleToggle(key); } }}
        className={cn(
          "flex items-center gap-3 px-3.5 py-3 border-b border-border last:border-b-0 transition-colors",
          updating ? "opacity-60 cursor-wait" : busy ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-accent/20",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium font-mono">{key}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-200 uppercase tracking-wide">
              unavailable
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            No longer in the company library — toggle off to remove.
          </div>
        </div>
        <div className="relative w-9 h-5 rounded-full shrink-0 transition-colors bg-green-500">
          <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all right-0.5" />
        </div>
      </div>
    );
  };

  return (
    <div className="py-2 space-y-4 max-w-[1400px]">
      <p className="text-sm text-muted-foreground">
        Only skills attached here are provided to this agent at runtime. The agent can't use any skill that isn't attached here.
      </p>
      <div className="flex items-center gap-2 border border-border rounded-md px-3 py-2 text-sm">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills…"
          className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">
          Attached · {attached.length + orphanKeys.length}
        </div>
        {attached.length + orphanKeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No skills attached.</p>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden">
            {attached.map(renderRow)}
            {orphanKeys.map(renderOrphanRow)}
          </div>
        )}
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">Available</div>
        {available.length === 0 ? (
          <p className="text-sm text-muted-foreground">{q ? "No matches." : "All skills attached."}</p>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden">{available.map(renderRow)}</div>
        )}
      </div>
    </div>
  );
}
