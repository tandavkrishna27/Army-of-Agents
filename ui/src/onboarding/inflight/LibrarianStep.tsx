import { useEffect, useRef, useState } from "react";
import type { MemoryItem } from "@armyofagents/shared";
import { projectsApi } from "../../api/projects";
import {
  braindumpApi,
  clearBraindumpSessionId,
  getBraindumpSessionId,
  type BraindumpCapture,
} from "../../api/braindump";
import { memoryApi } from "../../api/memory";
import { Button } from "@/components/ui/button";
import { AgentCharacter, Reveal } from "../motion";
import { GradientText, StepCard, StepHeading, StepShell } from "../steps/shared";

/** Interval (ms) between capture-status poll ticks while the Librarian is
 *  organizing. Matches the cadence of VerifyStep's login poll. */
const POLL_INTERVAL_MS = 3000;

/**
 * How long to keep polling before giving up on "Organizing…". A capture can
 * stay non-terminal for reasons the founder can't act on (a dead run whose
 * failure write never landed, a genuinely slow CLI), and an onboarding step
 * that spins indefinitely is a dead end. After this we stop, say plainly that
 * the Librarian is still working, and let them continue — the proposals show
 * up in Memory whenever it finishes.
 */
const POLL_DEADLINE_MS = 120_000;

function isTerminal(status: BraindumpCapture["status"]): boolean {
  return status === "proposed" || status === "failed";
}

export type LibrarianStepProps = {
  companyId: string;
  onDone: () => void;
};

/**
 * WS6 — the In-flight "Librarian" surface. Standalone, like `BraindumpStep`
 * (which precedes it) — domain-only, no `advanceOnboarding` call; WS9
 * sequences Braindump -> Librarian onto Home.
 *
 * Polls every department's braindump captures (the synchronous dispatch in
 * `POST /braindumps` usually already lands "proposed"/"failed" by the time
 * this mounts, but a still-"pending"/"running" row — e.g. a retry racing a
 * page load — keeps the AgentCharacter in `thinking` until every capture
 * reaches a terminal status). Once terminal, flips to `done` and lists the
 * proposed `domain` memory items for inline approval via the REAL founder
 * approval route (`memoryApi.approve` -> `POST .../memory/:id/approve`) —
 * never a bespoke write. A `failed` capture shows its `failureReason` with a
 * Retry action (`braindumpApi.retry`). Continue always fires `onDone` — this
 * step never blocks the founder from moving on, even mid-organizing.
 */
export function LibrarianStep({ companyId, onDone }: LibrarianStepProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [organizing, setOrganizing] = useState(true);
  const [captures, setCaptures] = useState<BraindumpCapture[]>([]);
  const [pendingItems, setPendingItems] = useState<MemoryItem[]>([]);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [departmentNames, setDepartmentNames] = useState<Map<string, string>>(new Map());
  /** Set when polling hit POLL_DEADLINE_MS with captures still non-terminal. */
  const [stillWorking, setStillWorking] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Latest captures, readable from the poll timer without re-arming it. */
  const capturesRef = useRef<BraindumpCapture[]>([]);
  const mountedRef = useRef(true);
  const doneFiredRef = useRef(false);

  function fireOnDoneOnce() {
    if (doneFiredRef.current) return;
    doneFiredRef.current = true;
    // The run is reviewed — end it, so a later braindump mints a fresh id
    // instead of reusing these captures' idempotency keys.
    clearBraindumpSessionId(companyId);
    onDone();
  }

  function clearPoll() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPoll();
    };
  }, []);

  /**
   * Phase 5e: ONE call for the whole company, both scopes. The previous
   * per-department sweep couldn't see the company-wide capture at all, so a
   * founder who only filled the Company card saw "no braindumps" and the step
   * declared itself finished while the Librarian was still running.
   */
  async function fetchCaptures(): Promise<BraindumpCapture[]> {
    const all = await braindumpApi.list(companyId);
    // Scope to THIS onboarding session. The company-wide list also returns
    // captures from earlier sessions, and mixing them in is not cosmetic: a
    // stale "running" row would keep this step on "Organizing…" forever, and
    // old proposals would show up here to be approved as if the founder had
    // just written them. Every key this session mints ends with the session id
    // (braindumpIdempotencyKey), which is what makes the match exact.
    const suffix = `:${getBraindumpSessionId(companyId)}`;
    return all.filter((c) => c.idempotencyKey.endsWith(suffix));
  }

  /**
   * Scopes the approve list to THIS braindump run — every terminal capture's
   * `proposedMemoryItemIds` is the authoritative set. Without this, fetching
   * ALL pending `domain` memory would leak unrelated pending items (Memory
   * Keeper, discussions, other departments) into this step's Approve list.
   * `captures` is passed explicitly rather than read from state — callers
   * (initial load, pollTick, retry) always have the freshest array in hand
   * before the corresponding `setCaptures` re-render lands.
   */
  async function fetchPendingItems(captures: BraindumpCapture[]) {
    const proposedIds = new Set(captures.flatMap((c) => c.proposedMemoryItemIds));
    if (proposedIds.size === 0) {
      if (mountedRef.current) setPendingItems([]);
      return;
    }
    try {
      // Both layers: a company-wide braindump proposes IDENTITY memory, a
      // department one proposes DOMAIN. Fetching only domain would drop every
      // company proposal from the approve list while still counting it as
      // "organized". Two scoped calls rather than one unfiltered one keeps the
      // responses bounded; proposedIds is still the authoritative filter.
      const [domain, identity] = await Promise.all([
        memoryApi.list(companyId, { status: "pending", layer: "domain" }),
        memoryApi.list(companyId, { status: "pending", layer: "identity" }),
      ]);
      // Dedup by id: two responses are merged, and an item appearing in both
      // (an API that ignores the layer filter) would otherwise render twice
      // with a duplicate React key and offer two Approve buttons for one item.
      const byId = new Map<string, MemoryItem>();
      for (const item of [...domain.items, ...identity.items]) {
        if (proposedIds.has(item.id)) byId.set(item.id, item);
      }
      if (mountedRef.current) setPendingItems([...byId.values()]);
    } catch {
      // Best-effort — the approve list just stays empty/stale; Continue still works.
    }
  }

  async function pollTick() {
    try {
      const next = await fetchCaptures();
      if (!mountedRef.current) return;
      capturesRef.current = next;
      setCaptures(next);
      if (next.every((c) => isTerminal(c.status))) {
        clearPoll();
        setOrganizing(false);
        await fetchPendingItems(next);
      }
    } catch {
      // transient — keep polling
    }
  }

  function startPolling() {
    clearPoll();
    const startedAt = Date.now();
    pollRef.current = setInterval(() => {
      if (Date.now() - startedAt >= POLL_DEADLINE_MS) {
        clearPoll();
        if (!mountedRef.current) return;
        setStillWorking(true);
        setOrganizing(false);
        void fetchPendingItems(capturesRef.current);
        return;
      }
      void pollTick();
    }, POLL_INTERVAL_MS);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Department names label the capture rows; the captures themselves
        // come from one company-wide call, so a company with zero departments
        // is no longer an early-exit — it can still have a company capture.
        const projects = await projectsApi.list(companyId);
        if (cancelled) return;
        setDepartmentNames(
          new Map(projects.filter((p) => p.type === "department").map((p) => [p.id, p.name])),
        );

        const initial = await fetchCaptures();
        if (cancelled) return;
        capturesRef.current = initial;
        setCaptures(initial);

        if (initial.length === 0) {
          setOrganizing(false);
          await fetchPendingItems([]);
          return;
        }

        const inFlight = initial.some((c) => !isTerminal(c.status));
        if (!inFlight) {
          setOrganizing(false);
          await fetchPendingItems(initial);
        } else {
          setOrganizing(true);
          startPolling();
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Couldn't load your braindumps.");
          setOrganizing(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per companyId; poll lifecycle is self-managed via refs.
  }, [companyId]);

  async function approve(id: string) {
    setApprovingId(id);
    try {
      await memoryApi.approve(companyId, id);
      if (mountedRef.current) setPendingItems((prev) => prev.filter((i) => i.id !== id));
    } catch {
      // leave the item in the list — the founder can retry the click.
    } finally {
      if (mountedRef.current) setApprovingId(null);
    }
  }

  async function retry(captureId: string) {
    setRetryingId(captureId);
    try {
      const updated = await braindumpApi.retry(companyId, captureId);
      if (!mountedRef.current) return;
      const nextCaptures = captures.map((c) => (c.id === captureId ? updated : c));
      setCaptures(nextCaptures);
      if (!isTerminal(updated.status)) {
        setOrganizing(true);
        startPolling();
      } else {
        await fetchPendingItems(nextCaptures);
      }
    } catch {
      // leave the failed state as-is; Retry stays clickable.
    } finally {
      if (mountedRef.current) setRetryingId(null);
    }
  }

  const failedCaptures = captures.filter((c) => c.status === "failed");

  /**
   * Groups proposals by the scope they belong to, so the founder approves
   * "Company-wide" knowledge knowing it's company-wide. Membership comes from
   * each CAPTURE's proposedMemoryItemIds rather than the item's own
   * departmentId — that's the same authoritative linkage the approve list is
   * already filtered by, and it stays correct even for an item the Librarian
   * filed without a department.
   */
  const groupedItems = (() => {
    const scopeOf = new Map<string, string>();
    for (const capture of captures) {
      const label = capture.departmentId
        ? (departmentNames.get(capture.departmentId) ?? "Department")
        : "Company-wide";
      for (const itemId of capture.proposedMemoryItemIds) scopeOf.set(itemId, label);
    }
    const groups = new Map<string, MemoryItem[]>();
    for (const item of pendingItems) {
      const label = scopeOf.get(item.id) ?? "Other";
      const bucket = groups.get(label);
      if (bucket) bucket.push(item);
      else groups.set(label, [item]);
    }
    // Company-wide first — it's the broadest claim and deserves the most
    // deliberate approval.
    return [...groups.entries()].sort(([a], [b]) =>
      a === "Company-wide" ? -1 : b === "Company-wide" ? 1 : a.localeCompare(b),
    );
  })();

  return (
    <StepShell className="max-w-lg">
      <Reveal>
        <StepHeading
          title={
            organizing ? (
              <>
                Organizing your <GradientText>knowledge</GradientText>…
              </>
            ) : (
              <>
                Your domain <GradientText>memory</GradientText> is ready
              </>
            )
          }
          subtitle={
            organizing
              ? "The Librarian is reading through what you shared and proposing memory items."
              : "Review what the Librarian found — approve what looks right."
          }
        />
      </Reveal>

      <Reveal delay={0.09}>
        <div className="flex flex-col items-center gap-3">
          <AgentCharacter state={organizing ? "thinking" : "done"} />
        </div>
      </Reveal>

      {loadError && <p className="text-center text-xs text-destructive">{loadError}</p>}

      <Reveal delay={0.12}>
        <p className="text-center text-xs text-dim">
          We're sorting this into your company's memory in the background — you can review and
          approve it in Memory whenever you're ready.
        </p>
      </Reveal>

      {stillWorking && (
        <Reveal delay={0.12}>
          <p className="text-center text-xs text-dim">
            The Librarian is still working on this one. You can continue — anything it proposes
            will be waiting for you in Memory.
          </p>
        </Reveal>
      )}

      {failedCaptures.length > 0 && (
        <div className="flex flex-col gap-2">
          {failedCaptures.map((c) => (
            <Reveal key={c.id} delay={0.14}>
              <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3">
                <p className="text-xs text-destructive">
                  {c.failureReason ?? "This braindump couldn't be organized."}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={retryingId === c.id}
                  onClick={() => void retry(c.id)}
                >
                  {retryingId === c.id ? "Retrying…" : "Retry"}
                </Button>
              </div>
            </Reveal>
          ))}
        </div>
      )}

      {!organizing && !loading && (
        <div className="flex flex-col gap-2">
          {pendingItems.length === 0 && (
            <p className="text-center text-xs text-dim">No proposed memory items yet.</p>
          )}
          {groupedItems.map(([label, items]) => (
            <div key={label} className="flex flex-col gap-2">
              <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-dim">{label}</p>
              {items.map((item, i) => (
                <Reveal key={item.id} delay={0.09 + i * 0.06}>
                  <StepCard>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text">{item.title}</p>
                        <p className="mt-1 text-xs text-dim">{item.content}</p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        className="shrink-0"
                        disabled={approvingId === item.id}
                        onClick={() => void approve(item.id)}
                      >
                        {approvingId === item.id ? "Approving…" : "Approve"}
                      </Button>
                    </div>
                  </StepCard>
                </Reveal>
              ))}
            </div>
          ))}
        </div>
      )}

      <Reveal delay={0.36}>
        <Button className="w-full" onClick={fireOnDoneOnce}>
          Continue
        </Button>
      </Reveal>
    </StepShell>
  );
}
