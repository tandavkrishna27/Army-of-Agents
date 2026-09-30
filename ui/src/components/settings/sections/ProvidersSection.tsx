/**
 * Settings -> Providers.
 *
 * The one place a founder can see, in a single screen, whether each AI CLI is
 * installed, signed in and actually able to run — and fix it where it isn't.
 *
 * This file is DELIBERATELY thin. All rendering lives in the shared
 * `ProviderReadinessCard` (design D6, "extract, don't duplicate") and all wire
 * shapes live in `api/providers.ts`. The page owns exactly three things the card
 * cannot: WHEN to fetch, WHEN to probe, and the login challenge lifecycle.
 *
 * Three invariants govern it:
 *
 *  1. RENDER FROM CACHE, NEVER PROBE ON LOAD (design D3). Each probe spawns a
 *     real CLI (~1-3s x 8 providers), so opening a settings tab must not stall
 *     the machine. `GET /` returns cached verdicts; only providers that are BOTH
 *     in use (at least one agent bound to them) AND stale are auto-refreshed.
 *     Refreshing everything would be a probe storm wearing a cache's clothes.
 *
 *  2. ONE PROBE AT A TIME. The server holds a single per-company probe slot and
 *     answers a second concurrent request with 429, so `Test all` is a
 *     sequential await-loop, not `Promise.all`. Parallel calls would 429 each
 *     other and report failures that are purely self-inflicted.
 *
 *  3. NEVER STRAND A LOGIN CHALLENGE. The CLI login slot is keyed
 *     `(provider, authHome)` and is HOST-SHARED — every company on this machine
 *     contends for it. A pending challenge left behind on unmount makes every
 *     other company receive 409, so the cleanup effect cancels it.
 *
 * Failures are handed to the card's `error` prop RAW. The card turns 429 / 409 /
 * login-unavailable into founder-readable copy via `providerActionError`, so
 * re-deriving that here would be a second wording of the same failure.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isReadinessStale, type ProviderId } from "@armyofagents/shared";
import { useCompany } from "@/context/CompanyContext";
import {
  providersApi,
  type ProviderLoginMode,
  type ProviderStatusRow,
} from "@/api/providers";
import { ApiError } from "@/api/client";
import {
  ProviderReadinessCard,
  type ProviderCardBusy,
} from "@/components/providers/ProviderReadinessCard";
import { ProviderList } from "@/components/providers/ProviderList";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { PageSkeleton } from "@/components/PageSkeleton";

/**
 * Login poll cadence. Exported so tests drive the real interval instead of
 * asserting against a number they chose themselves.
 */
export const LOGIN_POLL_INTERVAL_MS = 2500;

interface ActiveLogin {
  providerId: ProviderId;
  challengeId: string;
  loginUrl: string | null;
  mode: ProviderLoginMode;
  userCode: string | null;
  expiresAt: string;
  status: "pending" | "completed" | "failed" | "timeout";
}

export function ProvidersSection() {
  const { selectedCompanyId } = useCompany();

  if (!selectedCompanyId) {
    return (
      <section className="p-8">
        <p className="text-sm text-muted-foreground">
          Select a company to manage providers.
        </p>
      </section>
    );
  }

  // Keyed so switching companies remounts: the login challenge and the
  // auto-refresh ledger below are both per-company and must not carry over.
  return <ProvidersPanel key={selectedCompanyId} companyId={selectedCompanyId} />;
}

/**
 * The provider the detail pane shows when the founder has not picked one.
 * Prefer an in-use provider — that is where a broken credential actually stops
 * work — then fall back to the first provider, then null (empty catalog).
 */
function defaultSelectedId(rows: ProviderStatusRow[]): ProviderId | null {
  const inUse = rows.find((r) => r.agents.length > 0);
  return (inUse ?? rows[0])?.descriptor.id ?? null;
}

function ProvidersPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.providers.list(companyId);

  const { data, isLoading, error: listError } = useQuery({
    queryKey,
    queryFn: () => providersApi.list(companyId),
  });
  const rows: ProviderStatusRow[] = data?.providers ?? [];

  const [selectedId, setSelectedId] = useState<ProviderId | null>(null);
  // Guard a stale id (e.g. after a refetch): fall back to the default rather
  // than render an empty pane for a provider that is no longer listed.
  const effectiveId: ProviderId | null =
    selectedId && rows.some((r) => r.descriptor.id === selectedId)
      ? selectedId
      : defaultSelectedId(rows);
  const selectedRow = rows.find((r) => r.descriptor.id === effectiveId) ?? null;

  const [busy, setBusy] = useState<Record<string, ProviderCardBusy>>({});
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const [login, setLogin] = useState<ActiveLogin | null>(null);
  const [testingAll, setTestingAll] = useState(false);

  const setBusyFor = useCallback((id: string, patch: ProviderCardBusy) => {
    setBusy((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);
  const setErrorFor = useCallback((id: string, err: unknown) => {
    setErrors((prev) => ({ ...prev, [id]: err }));
  }, []);

  const refreshList = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    // queryKey is derived from companyId, which is fixed for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, companyId],
  );

  /* ── probing ─────────────────────────────────────────────────────────── */

  const runTest = useCallback(
    async (providerId: ProviderId) => {
      setBusyFor(providerId, { test: true });
      setErrorFor(providerId, null);
      try {
        await providersApi.test(companyId, providerId);
      } catch (e) {
        // Raw — the card owns the wording (429 back-off copy, etc).
        setErrorFor(providerId, e);
      } finally {
        setBusyFor(providerId, { test: false });
        // Refetch even on failure: a probe that fails during config resolution
        // still records a fresh `failed` row server-side, so the card must
        // refetch to drop any stale `Ready` — not only on the success path.
        await refreshList();
      }
    },
    [companyId, refreshList, setBusyFor, setErrorFor],
  );

  /*
    Sequential on purpose. The server's per-company probe slot means a
    Promise.all here would 429 every provider after the first and paint a wall
    of red on a perfectly healthy machine.
  */
  const testAll = useCallback(async () => {
    setTestingAll(true);
    try {
      for (const row of rows) {
        await runTest(row.descriptor.id);
      }
    } finally {
      setTestingAll(false);
    }
  }, [rows, runTest]);

  /*
    Auto-refresh, D3. IN USE (`agents.length > 0`) AND STALE only. `agents` is
    the server's in-use set — it lists the agents actually bound to this
    provider — so an untouched provider nobody runs stays on its cached verdict
    until the founder asks.

    The ledger is what stops a loop: each successful probe invalidates the list,
    the refetch re-runs this effect, and without a record of what was already
    refreshed the same stale-looking row would probe forever.
  */
  const autoRefreshedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Don't race `Test all`: it probes sequentially through the SAME per-company
    // slot, so an auto-refresh firing on its mid-run refetch would double-probe a
    // provider and 429 the second one on a healthy machine.
    if (!data || testingAll) return;
    const targets = data.providers.filter(
      (row) =>
        row.agents.length > 0 &&
        isReadinessStale(row.companyDefault.testedAt) &&
        !autoRefreshedRef.current.has(row.descriptor.id),
    );
    if (targets.length === 0) return;
    for (const t of targets) autoRefreshedRef.current.add(t.descriptor.id);
    void (async () => {
      // Same single-slot constraint as `Test all`.
      for (const t of targets) await runTest(t.descriptor.id);
    })();
  }, [data, runTest, testingAll]);

  /* ── key save ────────────────────────────────────────────────────────── */

  /*
    Deliberately RE-THROWS. The card clears its draft on resolve and retains it
    on reject; swallowing the rejection here would clear a key that was never
    stored and leave the founder with nothing to retry from.
  */
  const saveKey = useCallback(
    async (providerId: ProviderId, value: string) => {
      setBusyFor(providerId, { key: true });
      setErrorFor(providerId, null);
      try {
        await providersApi.saveKey(companyId, providerId, value);
        // A saved key can re-key a whole credential group (Cursor + Cursor
        // Cloud, Pi + Claude), so refresh the entire list, not one row.
        await refreshList();
      } finally {
        setBusyFor(providerId, { key: false });
      }
    },
    [companyId, refreshList, setBusyFor, setErrorFor],
  );

  /* ── login lifecycle ─────────────────────────────────────────────────── */

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeLoginRef = useRef<{ providerId: ProviderId; challengeId: string } | null>(null);

  const clearPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const poll = useCallback(
    async (providerId: ProviderId, challengeId: string) => {
      try {
        const res = await providersApi.loginStatus(companyId, providerId, challengeId);
        // A late response for a challenge we already abandoned must not
        // resurrect it.
        if (activeLoginRef.current?.challengeId !== challengeId) return;
        setLogin((prev) =>
          prev && prev.challengeId === challengeId
            ? { ...prev, status: res.status, loginUrl: res.loginUrl ?? prev.loginUrl }
            : prev,
        );

        if (res.status === "completed") {
          // TERMINAL. Stop polling before anything else — an await below would
          // otherwise let the interval fire again for a finished challenge.
          clearPoll();
          activeLoginRef.current = null;
          setLogin(null);
          /*
            The status route re-probes on the poll that FIRST observes
            completion and hands the fresh row back as `readiness`. Probing
            again here would spawn a second CLI for a verdict we already have —
            and would likely 429 against the server's own probe. `readiness` is
            null only when that best-effort probe could not run, which is
            exactly when we should run one.
          */
          if (!res.readiness) {
            try {
              await providersApi.test(companyId, providerId);
            } catch {
              // Non-fatal: the card just keeps showing the pre-login verdict
              // until the founder presses Test.
            }
          }
          await refreshList();
        } else if (res.status === "failed" || res.status === "timeout") {
          clearPoll();
          activeLoginRef.current = null;
          setLogin(null);
          setErrorFor(providerId, new Error(`Sign-in ${res.status}. Try again.`));
        }
      } catch (err) {
        // A 404 means the challenge is GONE — reaped, cancelled from another
        // tab, or lost across a backend restart. The server will never send a
        // terminal status for a challenge it no longer has, so polling would
        // spin "Waiting for sign-in…" forever. Treat it as terminal.
        if (err instanceof ApiError && err.status === 404) {
          if (activeLoginRef.current?.challengeId === challengeId) {
            clearPoll();
            activeLoginRef.current = null;
            setLogin(null);
            setErrorFor(providerId, new Error("Sign-in session expired. Start again."));
          }
          return;
        }
        // Otherwise transient (a dropped request mid-login) — keep polling. The
        // server times the live challenge out on its own.
      }
    },
    [companyId, refreshList, setErrorFor],
  );

  const startLogin = useCallback(
    async (providerId: ProviderId) => {
      setBusyFor(providerId, { login: true });
      setErrorFor(providerId, null);
      try {
        const { challengeId, loginUrl, mode, userCode, expiresAt } =
          await providersApi.startLogin(companyId, providerId);
        activeLoginRef.current = { providerId, challengeId };
        setLogin({
          providerId,
          challengeId,
          loginUrl,
          mode,
          userCode,
          expiresAt,
          status: "pending",
        });
        clearPoll();
        pollRef.current = setInterval(
          () => void poll(providerId, challengeId),
          LOGIN_POLL_INTERVAL_MS,
        );
        void poll(providerId, challengeId); // once immediately, not a full interval of dead air
      } catch (e) {
        // Raw: a 409 here means another company on this host holds the shared
        // slot, and the card already has the words for that.
        setErrorFor(providerId, e);
      } finally {
        setBusyFor(providerId, { login: false });
      }
    },
    [companyId, poll, setBusyFor, setErrorFor],
  );

  const cancelLogin = useCallback(() => {
    const active = activeLoginRef.current;
    clearPoll();
    activeLoginRef.current = null;
    setLogin(null);
    if (!active) return;
    void providersApi
      .cancelLogin(companyId, active.providerId, active.challengeId)
      .catch(() => {});
  }, [companyId]);

  /*
    Release the HOST-SHARED slot on unmount. Without this, navigating away
    mid-login strands a pending challenge and every other company on this
    machine gets 409 until the server times it out.
  */
  useEffect(
    () => () => {
      clearPoll();
      const active = activeLoginRef.current;
      activeLoginRef.current = null;
      if (active) {
        void providersApi
          .cancelLogin(companyId, active.providerId, active.challengeId)
          .catch(() => {});
      }
    },
    [companyId],
  );

  /* ── borrower navigation ─────────────────────────────────────────────── */

  // One card is visible at a time now, so a borrower's "managed on the owner's
  // card" link SELECTS the owner rather than scrolling to it.
  const openProvider = useCallback((ownerId: ProviderId) => {
    setSelectedId(ownerId);
  }, []);

  /* ── render ──────────────────────────────────────────────────────────── */

  if (isLoading) return <PageSkeleton />;

  return (
    <section
      className="flex flex-col gap-4 p-4 md:h-full md:min-h-0 md:p-6"
      data-testid="providers-section"
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Providers</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Install and sign in to your AI CLIs. Status is shown from the last check —
            press Test to check again.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="providers-test-all"
          disabled={testingAll || rows.length === 0}
          onClick={() => void testAll()}
        >
          {testingAll ? "Testing…" : "Test all"}
        </Button>
      </header>

      {listError && (
        <p role="alert" className="text-sm text-destructive" data-testid="providers-list-error">
          {listError instanceof Error ? listError.message : "Could not load providers."}
        </p>
      )}

      {/*
        Two SEPARATE full-height panels with a gap — not one bordered box split by
        an internal border. The row fills the remaining height (`md:flex-1`) and
        each panel scrolls INSIDE itself, so selecting a provider swaps the detail
        content without resizing the container. Below `md` the panels stack and the
        page scrolls normally.
      */}
      <div
        className="grid gap-3 md:min-h-0 md:flex-1 md:grid-cols-[240px_minmax(0,1fr)]"
        data-testid="providers-two-pane"
      >
        <ProviderList rows={rows} selectedId={effectiveId} onSelect={setSelectedId} />
        <div
          className="min-w-0 overflow-y-auto rounded-xl border border-border bg-card p-4 md:h-full md:p-6"
          data-testid="provider-detail"
          data-provider={selectedRow?.descriptor.id}
        >
          {selectedRow ? (
            <ProviderReadinessCard
              // Key by provider so switching rows REMOUNTS the card. Without this,
              // React reuses the instance and its uncommitted key draft survives
              // the switch — a founder who pastes a key, clicks another provider,
              // then Saves would store that key under the wrong provider.
              key={selectedRow.descriptor.id}
              row={selectedRow}
              onTest={() => void runTest(selectedRow.descriptor.id)}
              onSaveKey={(value) => saveKey(selectedRow.descriptor.id, value)}
              onStartLogin={() => void startLogin(selectedRow.descriptor.id)}
              onCancelLogin={cancelLogin}
              login={
                login && login.providerId === selectedRow.descriptor.id
                  ? {
                      status: login.status,
                      loginUrl: login.loginUrl,
                      mode: login.mode,
                      userCode: login.userCode,
                      expiresAt: login.expiresAt,
                    }
                  : null
              }
              onOpenProvider={openProvider}
              busy={busy[selectedRow.descriptor.id] ?? {}}
              error={errors[selectedRow.descriptor.id] ?? null}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Select a provider.</p>
          )}
        </div>
      </div>
    </section>
  );
}
