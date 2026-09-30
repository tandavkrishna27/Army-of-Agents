/**
 * Readiness badge for ONE agent's own provider scope, rendered on the agent
 * config form.
 *
 * This is the only surface in the product that probes an agent scope. The
 * Settings -> Providers tab deliberately does not (design D3: eight-to-ten CLI
 * spawns behind one button is a probe storm), so its per-agent rows can only
 * report what some earlier probe recorded. That makes the Test button below the
 * mechanism by which an agent leaves the unchecked state at all.
 *
 * TWO-KEY LOOKUP, NO FALLBACK. The provider row is found by the agent's
 * EFFECTIVE (draft-aware) adapter type, then the agent's own entry is found
 * inside it by id. `readinessForScope` returns `undefined` for an agent nobody
 * has probed, and that is deliberately NOT backfilled with `row.companyDefault`:
 * an agent binds its own credential through `adapterConfig.env`, so "the company
 * key authenticates" does not imply "this agent can run". Rendering the company
 * default here is precisely the false-green this whole feature removes — and the
 * P1-1 case (agent `needs_auth`, company default `verified`) is the one the
 * badge exists to make visible.
 *
 * All copy and colour come from `ProviderReadinessCard`'s canonical
 * `outcomeLabel` / `outcomeTone` / `TONE_CLASS`. There is no second vocabulary
 * here on purpose.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getProviderByAdapterType } from "@armyofagents/shared";
import { useState } from "react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { providersApi, readinessForScope } from "@/api/providers";
import {
  TONE_CLASS,
  outcomeLabel,
  outcomeTone,
  providerActionErrorCopy,
} from "@/components/providers/ProviderReadinessCard";
import { queryKeys } from "@/lib/queryKeys";

export interface AgentReadinessBadgeProps {
  companyId: string;
  /**
   * The persisted agent's id. Create mode passes nothing: an agent that does not
   * exist yet has no scope to probe, and probing the company default and
   * labelling it as this agent's status would be the false-green again.
   */
  agentId?: string | null;
  /**
   * The EFFECTIVE adapter type — the draft value from the form's overlay, not
   * `agent.adapterType`. A founder mid-switch from `claude_local` to
   * `codex_local` must see Codex's readiness, because that is what the agent
   * will run on once saved.
   */
  adapterType: string;
  /**
   * The PERSISTED agent's adapter type. When it differs from `adapterType` the
   * founder has switched the adapter in the form but not saved: the agent-scope
   * probe keys off the persisted row, and the providers route rejects a mismatch
   * as "Agent does not use provider ...". So Test cannot check the draft provider
   * until the change is saved — the button is disabled and a hint explains why,
   * rather than letting Test fail with a confusing error mid-edit.
   */
  savedAdapterType?: string;
}

export function AgentReadinessBadge({
  companyId,
  agentId,
  adapterType,
  savedAdapterType,
}: AgentReadinessBadgeProps) {
  const queryClient = useQueryClient();
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<unknown>(null);

  // KEY 1, catalog half. Adapters with no credentialed provider (`process`,
  // `http`, `openclaw`, `hermes_local`) have no readiness to report, so we
  // neither render nor FETCH for them.
  const descriptor = getProviderByAdapterType(adapterType);
  const enabled = Boolean(companyId) && Boolean(descriptor) && Boolean(agentId);

  const queryKey = queryKeys.providers.list(companyId);
  const { data } = useQuery({
    queryKey,
    queryFn: () => providersApi.list(companyId),
    enabled,
  });

  if (!descriptor || !agentId) return null;

  // KEY 1, wire half. The catalog knowing about a provider does not mean the
  // server returned a row for it.
  const row = data?.providers.find((r) => r.descriptor.adapterType === adapterType);
  if (!row) return null;

  // KEY 2. No `?? row.companyDefault` — see the file header.
  const scoped = readinessForScope(row, { scopeType: "agent", agentId });
  const outcome = scoped?.outcome ?? "unknown";
  const tone = outcomeTone(outcome);

  // Draft adapter switch: the form shows a different provider than the one the
  // agent is saved with. The agent-scope probe can only test the persisted row,
  // so Test would 400 ("Agent does not use provider ...") until the change is
  // saved. Disable Test and explain instead of surfacing that error.
  const isDraftAdapterSwitch = Boolean(savedAdapterType) && savedAdapterType !== adapterType;

  const runTest = async () => {
    setTesting(true);
    setTestError(null);
    try {
      await providersApi.test(companyId, descriptor.id, { scopeType: "agent", agentId });
    } catch (e) {
      setTestError(e);
    } finally {
      setTesting(false);
      // Refetch even on failure: a probe that fails during runtime config
      // resolution (e.g. a revoked secret_ref) still records a fresh `failed`
      // row server-side, so the badge must refetch to replace any stale `Ready`
      // — not only on the success path.
      await queryClient.invalidateQueries({ queryKey });
    }
  };

  const errorCopy = providerActionErrorCopy(testError);

  return (
    <div className="flex flex-col items-start gap-1" data-testid="agent-readiness">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground">{descriptor.label}</span>
        {/*
          role="status" + aria-live: pressing Test swaps this badge in place, so
          a screen-reader user would otherwise get silence from the one element
          whose entire job is announcing status. Same convention as the
          Settings-tab card.
        */}
        <span
          data-testid="agent-readiness-badge"
          data-tone={tone}
          role="status"
          aria-live="polite"
          className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASS[tone]}`}
        >
          {outcomeLabel(outcome)}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => void runTest()}
          disabled={testing || isDraftAdapterSwitch}
        >
          {testing ? "Checking..." : "Test"}
        </Button>
      </div>
      {isDraftAdapterSwitch && (
        <span className="text-[11px] text-muted-foreground" data-testid="agent-readiness-draft-switch">
          Save the adapter change to check {descriptor.label}.
        </span>
      )}
      {/*
        The badge label alone cannot distinguish "nobody has looked at this
        agent" from "we looked and learned nothing" — both are `unknown`, and
        `outcomeLabel` is deliberately one canonical word per outcome. This line
        carries the distinction instead of forking the vocabulary.
      */}
      {!scoped && !isDraftAdapterSwitch && (
        <span className="text-[11px] text-muted-foreground" data-testid="agent-readiness-never-checked">
          This agent hasn't been checked yet.
        </span>
      )}
      {errorCopy && (
        <span className="text-[11px] text-destructive" data-testid="agent-readiness-error">
          {errorCopy}
        </span>
      )}
      <Link
        to="/settings?tab=providers"
        className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Manage in Settings &rarr; Providers
      </Link>
    </div>
  );
}
