import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setFirstRunCompleted } from "../../api/onboarding";
import { DefineDepartments } from "./DefineDepartments";
import { IntegrationsStep } from "./IntegrationsStep";
import { BraindumpStep } from "./BraindumpStep";
import { LibrarianStep } from "./LibrarianStep";
import { CreateAgents } from "./CreateAgents";
import { FirstJobStep } from "./FirstJobStep";
import { StepPosition } from "../StepPosition";
import { ONBOARDING_STEPS } from "../steps";
import { computeFounderMapBase, computeOnboardingPosition } from "../onboardingProgress";

/** Fixed order (WS9 spec): Departments -> Integrations -> Braindump ->
 * Librarian -> CreateAgents -> FirstJob. */
export const IN_FLIGHT_SURFACES = [
  "departments",
  "integrations",
  "braindump",
  "librarian",
  "agents",
  "first_job",
] as const;
export type InFlightSurface = (typeof IN_FLIGHT_SURFACES)[number];

export type InFlightFlowProps = {
  companyId: string;
  deploymentMode?: "local_trusted" | "authenticated" | "cloud_auth";
  /** Fired once, after the FINAL surface's onDone AND `setFirstRunCompleted`
   * has resolved — the caller (`FirstRunHome`) hands off to steady Home. */
  onDone: () => void;
};

function stepStorageKey(companyId: string): string {
  return `aoa:inflight-step:${companyId}`;
}

function clampIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), IN_FLIGHT_SURFACES.length - 1);
}

/** Best-effort — a founder browsing in a locked-down/private-mode tab where
 * `localStorage` throws should still get a working (just non-resumable)
 * sequencer, not a crash. Falls back to step 0. */
function readStoredStep(companyId: string): number {
  try {
    const raw = window.localStorage.getItem(stepStorageKey(companyId));
    if (raw == null) return 0;
    return clampIndex(Number.parseInt(raw, 10));
  } catch {
    return 0;
  }
}

function writeStoredStep(companyId: string, index: number): void {
  try {
    window.localStorage.setItem(stepStorageKey(companyId), String(index));
  } catch {
    // best-effort — resume just restarts at the top next time.
  }
}

function clearStoredStep(companyId: string): void {
  try {
    window.localStorage.removeItem(stepStorageKey(companyId));
  } catch {
    // best-effort.
  }
}

/**
 * WS9 — the In-flight persona-tail sequencer. Home-hosted (WS0c §5), NOT a
 * `FlowEngine` step: each surface below does its own domain writes and never
 * calls `advanceOnboarding`.
 *
 * Deterministic resume (code-review fix, replaces the original ambient-data
 * resume): the sequencer's current step index is persisted to `localStorage`
 * keyed by companyId (`aoa:inflight-step:<companyId>`) and advanced as each
 * surface's `onDone` fires. On mount, the flow resumes from the stored index
 * (clamped to a valid range); the marker is cleared once the flow completes.
 *
 * The original resume checked ambient signals instead (a pre-existing
 * department -> skip Departments; a pre-existing org agent -> skip straight
 * to FirstJob). That was unsafe: sidebar nav stays live during first-run, so
 * a founder who created a department/agent from elsewhere (not through this
 * sequencer) was wrongly skipped past Integrations/Braindump/Librarian. Each
 * surface is already idempotent, so starting at step 0 when there's no
 * stored marker (fresh company, or a browser that can't persist) is safe.
 */
export function InFlightFlow({ companyId, deploymentMode, onDone }: InFlightFlowProps) {
  const [index, setIndex] = useState<number>(() => readStoredStep(companyId));
  const doneFiredRef = useRef(false);

  // Defensive resync if `companyId` ever changes under a mounted instance
  // (the common case — mount per company — is already covered by the lazy
  // initializer above).
  useEffect(() => {
    doneFiredRef.current = false;
    setIndex(readStoredStep(companyId));
  }, [companyId]);

  function advance() {
    setIndex((current) => {
      const next = current + 1;
      if (next >= IN_FLIGHT_SURFACES.length) {
        if (!doneFiredRef.current) {
          doneFiredRef.current = true;
          void setFirstRunCompleted(companyId).then((ok) => {
            // Only clear the resume marker once the completion write actually
            // landed. On a failed (best-effort) write the marker stays at the
            // final step, so a loop-back resumes at first-job — not from the top
            // of the tail.
            if (ok) clearStoredStep(companyId);
            onDone();
          });
        }
        return current;
      }
      writeStoredStep(companyId, next);
      return next;
    });
  }

  function goBack() {
    setIndex((i) => {
      const prev = Math.max(0, i - 1);
      writeStoredStep(companyId, prev);
      return prev;
    });
  }

  let surface: ReactNode = null;
  switch (IN_FLIGHT_SURFACES[index]) {
    case "departments":
      surface = <DefineDepartments companyId={companyId} onDone={advance} />;
      break;
    case "integrations":
      surface = <IntegrationsStep companyId={companyId} onDone={advance} />;
      break;
    case "braindump":
      surface = <BraindumpStep companyId={companyId} onDone={advance} />;
      break;
    case "librarian":
      surface = <LibrarianStep companyId={companyId} onDone={advance} />;
      break;
    case "agents":
      surface = <CreateAgents companyId={companyId} deploymentMode={deploymentMode} onDone={advance} />;
      break;
    case "first_job":
      surface = <FirstJobStep companyId={companyId} deploymentMode={deploymentMode} onDone={advance} />;
      break;
    default:
      surface = null;
  }

  // Continuous step counter (WS9): the In-flight tail extends the count past the
  // Map (BASE) by its surfaces — "Step BASE+1 of BASE+N" … BASE+N of BASE+N — so
  // the counter runs through the tail instead of vanishing after the spine.
  const pos = computeOnboardingPosition({
    phase: "inflight",
    base: computeFounderMapBase(ONBOARDING_STEPS, companyId),
    persona: "in_flight",
    inflightIndex: index,
    inflightApplicable: IN_FLIGHT_SURFACES.length,
  });

  return (
    <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-xl flex-col px-6 pt-8">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-[64px]">
          {index > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 gap-1 text-dim hover:bg-white/5 hover:text-text"
              onClick={goBack}
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
              Back
            </Button>
          )}
        </div>
        {pos && <StepPosition current={pos.current} total={pos.total} />}
      </div>
      <div className="flex flex-1 flex-col">
        <div className="my-auto w-full">{surface}</div>
      </div>
    </div>
  );
}
