import { useEffect, useRef, useState } from "react";
import { getFirstRunProgress, setFirstRunCompleted, setFirstRunPersona } from "../api/onboarding";
import { Button } from "@/components/ui/button";
import { DarkShell } from "./FlowEngine";
import { InFlightFlow } from "./inflight/InFlightFlow";
import { Map, type MapDoorPersona } from "./Map";
import { StepPosition } from "./StepPosition";
import { ONBOARDING_STEPS } from "./steps";
import { computeFounderMapBase, computeOnboardingPosition } from "./onboardingProgress";
import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

export type FirstRunHomeProps = {
  companyId: string;
  /** Fired once the first-run experience is fully done (Explorer picked, or
   * the In-flight tail finished) — the caller (`Dashboard`) should re-fetch
   * `firstRunCompleted` (e.g. invalidate the home-summary query) and swap to
   * steady Home. */
  onComplete?: () => void;
};

type Phase = "loading" | "door" | "in_flight" | "done" | "error";

/**
 * WS9 — Home's first-run branch (replaces the old Getting-Started checklist
 * branch in `Dashboard.tsx`). Renders inside the dark spine chrome
 * (`.onboarding-dark` + `ConstellationBg`, via `DarkShell`) so the Map and
 * every In-flight surface it hosts (which assume that ancestor scope — see
 * `steps/shared.tsx`) render correctly outside `FlowEngine`.
 *
 * Resume (WS0c §5): if `firstRunPersona` is already `"in_flight"` (the
 * founder picked that door on an earlier visit and left mid-sequence), skip
 * the door band entirely and go straight back into `InFlightFlow` — its own
 * data-driven resume takes it from there. Any other persona (including
 * `"explorer"`, which should already be completed by the time it's
 * persisted — see `handlePick`) falls back to showing the door band, which
 * is a safe, re-askable default.
 *
 * Read-failure handling (code-review fix): a FAILED `getFirstRunProgress`
 * must NOT silently fall back to the door band — an in-progress founder
 * (persona already `"in_flight"`) who hits a transient error would see the
 * door band again and could re-pick, or an Explorer pick would fire
 * `setFirstRunCompleted` prematurely on stale/absent progress data. Instead
 * it shows a minimal retry state and leaves completion untouched until the
 * read actually succeeds.
 */
export function FirstRunHome({ companyId, onComplete }: FirstRunHomeProps) {
  const healthQuery = useQuery({ queryKey: queryKeys.health, queryFn: () => healthApi.get() });
  const [phase, setPhase] = useState<Phase>("loading");
  const [retryToken, setRetryToken] = useState(0);
  // Captured in a ref so the load effect can call it without listing `onComplete`
  // as a dependency (callers may pass a fresh closure each render).
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    getFirstRunProgress(companyId)
      .then((progress) => {
        if (cancelled) return;
        // Already completed — e.g. the founder revisited /onboarding via history,
        // a bookmark, or stale routing. Never re-show the persona doors or re-run
        // the tail; hand straight back to the caller (which routes to the Lobby).
        if (progress.firstRunCompleted) {
          setPhase("done");
          onCompleteRef.current?.();
          return;
        }
        setPhase(progress.firstRunPersona === "in_flight" ? "in_flight" : "door");
      })
      .catch(() => {
        if (!cancelled) setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, retryToken]);

  async function handlePick(persona: MapDoorPersona) {
    await setFirstRunPersona(companyId, persona);
    if (persona === "explorer") {
      await setFirstRunCompleted(companyId);
      setPhase("done");
      onComplete?.();
      return;
    }
    setPhase("in_flight");
  }

  function handleInFlightDone() {
    // InFlightFlow already wrote firstRunCompleted before calling this.
    setPhase("done");
    onComplete?.();
  }

  // "done": the caller (Dashboard) is expected to swap away on `onComplete`
  // (e.g. by invalidating/refetching `firstRunCompleted`) — render nothing
  // rather than a second dark-chrome flash while that refetch is in flight.
  if (phase === "done") return null;

  // Continuous step counter (WS9): the Map is the BASE-th step, right after the
  // spine — so the counter carries through instead of vanishing here.
  const mapPos = computeOnboardingPosition({
    phase: "map",
    base: computeFounderMapBase(ONBOARDING_STEPS, companyId),
  });

  return (
    <DarkShell>
      {phase === "error" ? (
        <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm text-dim">Couldn&apos;t load your progress.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setRetryToken((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : phase === "in_flight" ? (
        <InFlightFlow
          companyId={companyId}
          deploymentMode={healthQuery.data?.deploymentMode}
          onDone={handleInFlightDone}
        />
      ) : phase === "door" ? (
        <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-3xl flex-col px-6 pt-8">
          <div className="flex items-center justify-end">
            {mapPos && <StepPosition current={mapPos.current} total={mapPos.total} />}
          </div>
          <div className="flex flex-1 flex-col">
            <div className="my-auto w-full">
              <Map onPick={handlePick} />
            </div>
          </div>
        </div>
      ) : null}
    </DarkShell>
  );
}
