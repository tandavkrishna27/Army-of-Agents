import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { fetchJourney, finalizeInvitedJoin } from "../api/onboarding";
import { HUMAN_ROLE_LABELS } from "@/lib/human-profile-constants";
import { queryKeys } from "@/lib/queryKeys";
import { DarkShell } from "./FlowEngine";
import { CompanyOrientation } from "./CompanyOrientation";
import { StepHeading } from "./steps/shared";

const POLL_MS = 7000;

type Phase = "checking" | "consent" | "pending" | "invite_invalid" | "not_approved" | "admitted";

/**
 * WS10 continuity: the invited journey's waiting/consent/checking phases render
 * in the SAME dark shell (`.onboarding-dark` + `<ConstellationBg/>`) as the
 * founder spine and the `admitted` MiniMap screen, so the teammate never drops
 * from the dark HumanProfileStep onto a bare light page mid-flow. Module-level
 * (not defined inside the polling component) so it keeps a stable component
 * identity across the 7s poll re-renders — an inline definition would remount
 * the shell (and restart the constellation animation) on every tick.
 */
function TerminalShell({ children }: { children: React.ReactNode }) {
  return (
    <DarkShell>
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-6 px-6 py-12 text-center">
        {children}
      </div>
    </DarkShell>
  );
}

/**
 * Terminal of the invited journey (spec §6). Attempts finalize on every poll
 * tick until it gets a definitive response — a verified email match admits
 * immediately (the invitation carried the approval), and a transient blip must
 * not silently downgrade an auto-admit-eligible user to founder-wait (finalize
 * is idempotent, so retrying is safe). Otherwise poll the journey until the
 * founder approves (the invitation leaves the pending set) or the request is
 * rejected / invalidated. Routing is invitation-driven, NOT journey-label
 * driven: an existing member of another company (journey "returning") with a
 * pending invitation here still gets the finalize attempt. Never navigates to
 * "/" while an invitation is still pending — that re-triggers the join loop.
 *
 * Consent gate: a tokenlessly-DETECTED invitation (`filed === false` — no
 * join_request exists; the user never clicked the invite link) is NEVER
 * auto-finalized. Clicking the link was the consent moment the detection path
 * removed, so an explicit "Join {company}" click stands in for it; only then
 * does finalize claim + file + auto-admit. Polling continues under the consent
 * card — a revoked/expired invite drops out of the pending set and the
 * not-approved/enter branches take over. This gate is defense-in-depth only:
 * the click also sets `acceptOpenInvite: true` on the finalize call, which the
 * server independently requires for the claim branch (it does not trust the
 * client not to skip this component).
 *
 * WS10: admission is no longer an immediate silent redirect. Every branch that
 * used to `await enter()` now prepares entry (evicts the cached pre-approval
 * journey + refreshes the companies list) and stops polling, but shows the
 * "admitted" terminal screen — a read-only `MiniMap` ("the machine you're
 * joining") — instead of navigating right away. The teammate only passes
 * through this join flow once, so this doubles as the flow's terminal screen;
 * navigation to Home happens on the explicit "Enter {company}" click
 * (`finishEnter`). No engine step is shown here (v1 decision — the company
 * Commander is company-scoped, not per-human).
 */
export function InvitedJoinTerminal() {
  const navigate = useNavigate();
  // Destructured to primitives: react-router's location object is stable per
  // navigation, but the test double for it is not (fresh object per render) —
  // depending on the whole object would re-run this effect (and repoll) on
  // every unrelated state update. Strings compare by value either way.
  const { pathname, search } = useLocation();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [phase, setPhase] = useState<Phase>("checking");
  const [company, setCompany] = useState<{ name: string; role: string } | null>(null);
  // Explicit consent for tokenless-detected invitations (filed === false).
  // State (not a ref) so flipping it re-runs the poll effect immediately —
  // the fresh tick performs the finalize the consent unlocked.
  const [consented, setConsented] = useState(false);
  const timerRef = useRef<number | null>(null);
  const finalizedRef = useRef(false);
  // The company the user actually came to join, captured on the FIRST tick that
  // resolves a target. Once the founder approves/rejects it the target leaves
  // pendingInvitations; re-deriving from the (shrinking) list would fall through
  // to a DIFFERENT pending invite and silently switch companies. Anchoring keeps
  // the page bound to the original target; its outcome is resolved in `!inv`.
  const anchoredTargetRef = useRef<string | null>(null);
  // The inviteId last processed for the anchored company. A reject→re-invite
  // cycle keeps the companyId (the anchor above) but mints a FRESH inviteId; a
  // change here means a NEW invitation surfaced for the same company and the
  // finalize/consent latch of the DEAD invite must be re-armed (see the tick).
  // Null until the first invitation resolves.
  const lastInviteIdRef = useRef<string | null>(null);

  // Evict the gate's cached pre-approval journey AND refresh the companies
  // list (the root CompanyContext subscription cached an empty list from
  // before membership existed — without this, a just-admitted teammate lands
  // on the founder-oriented empty Lobby). Runs as soon as admission is
  // detected, NOT on the "Enter" click — so the Home data is already warm by
  // the time the teammate clicks through the mini-map screen.
  //
  // Also backfills the company display name for the admitted screen. On the
  // deep-link race the target left `pendingInvitations` before the terminal's
  // first tick, so `company` was never set from an invitation and the copy
  // degrades to "Welcome to the team." The companies list just refreshed here
  // now contains the just-admitted company, so read its name from that cache
  // (no extra request, no server round-trip) and seed `company` when unset.
  const prepareEntry = useCallback(
    async (targetId: string | null) => {
      queryClient.removeQueries({ queryKey: ["onboarding", "journey"], exact: true });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      if (!targetId) return;
      const data = queryClient.getQueryData<{ companies: Array<{ id: string; name: string }> }>(
        queryKeys.companies.all,
      );
      const name = data?.companies.find((c) => c.id === targetId)?.name;
      if (name) setCompany((prev) => prev ?? { name, role: "" });
    },
    [queryClient],
  );

  // The explicit "Enter {company}" click on the admitted screen. `prepareEntry`
  // already ran when admission was detected, so this is a pure navigate.
  const finishEnter = useCallback(() => {
    navigate("/", { replace: true });
  }, [navigate]);

  useEffect(() => {
    let cancelled = false;
    // Re-arm the poll for the NEXT tick. Extracted so the states that LOOK
    // terminal but must keep polling (rejected / not-approved — a replacement
    // invite can still surface and re-arm the gate, see below) schedule
    // IDENTICALLY to the normal fall-through tail, instead of bare-returning and
    // killing the loop (Codex round-13 P2). Guarded by `cancelled` so an unmount
    // between an await and here never resurrects the loop. `tick` is referenced
    // before its declaration, but only ever CALLED after both are initialized —
    // no TDZ hazard.
    const scheduleNext = () => {
      if (!cancelled) {
        timerRef.current = window.setTimeout(() => void tick(), POLL_MS);
      }
    };
    const tick = async () => {
      try {
        const j = await fetchJourney();
        if (cancelled) return;
        // Invitation-driven: the journey label alone can't route this page —
        // "returning" means a membership exists SOMEWHERE (the resolver returns
        // it for members of any company), so an existing member with a pending
        // invitation for the target company must still get the finalize
        // attempt, not a bounce to "/". Precedence for the target:
        //   1. the explicit ?company= deep link (InviteLanding passes it) —
        //      AUTHORITATIVE whether or not it is currently in the pending set;
        //   2. the resolver's target (invited);
        //   3. the first pending invitation (returning, no deep link).
        // (1) is the round-14 fix: the deep-linked company can be resolved
        // (rejected/admitted) BEFORE this terminal's first tick — e.g. while the
        // user completed the profile step — so it is already absent from
        // pendingInvitations here. It must still anchor the deep-linked company
        // and report ITS outcome (via the idempotent finalize below), NOT fall
        // through to targetCompanyId/pendingInvitations[0] and silently switch to
        // a DIFFERENT pending invite. `|| null` treats an empty ?company= as no
        // deep link (matching the prior falsy check).
        const deepLinked = searchParams.get("company") || null;
        const invitations = j.pendingInvitations ?? [];
        // Derive the target — but only to SEED the anchor on the first resolving
        // tick (see anchoredTargetRef). After that, the anchor wins so an
        // approved/rejected target that dropped out of the pending set does NOT
        // fall through to invitations[0] (a different invite).
        const derivedTargetId =
          deepLinked ??
          (j.journey === "invited" ? j.targetCompanyId : invitations[0]?.companyId) ??
          null;
        if (anchoredTargetRef.current === null && derivedTargetId) {
          anchoredTargetRef.current = derivedTargetId;
        }
        const targetId = anchoredTargetRef.current ?? derivedTargetId;
        const inv = invitations.find((p) => p.companyId === targetId) ?? null;

        if (!inv) {
          // The anchored target is no longer pending — resolve ITS outcome, and
          // never fall through to another pending invite (the multi-invite
          // switch bug). Ask the idempotent, DEFINITIVE finalize — admitted:true
          // => approved, status "rejected" => rejected. That disambiguates the
          // "returning" label, which only means a membership exists SOMEWHERE
          // (possibly a DIFFERENT company) and so cannot tell "this target
          // approved" from "this target rejected but I'm already a member
          // elsewhere". We finalize when EITHER: we already engaged finalize for
          // this target (finalizedRef), OR it is the explicit ?company= deep link
          // (`targetId === deepLinked`). The deep-link case is the round-14 fix:
          // the user came for cA, so cA's outcome is authoritative even when cA
          // was resolved before our first tick and finalizedRef is still false —
          // without this we would skip the call and report the WRONG (fallback)
          // invite. This finalize is bare (no acceptOpenInvite), so it can only
          // report a filed request's outcome (approved/rejected/pending/invalid)
          // — it can NEVER claim/auto-admit a tokenless invite the user never
          // consented to (a no-record deep link 404s and degrades to the label).
          // A tokenless, non-deep-linked invite the user never consented to
          // (finalizedRef false, not the deep link) still skips the call and
          // relies on the label. Finalize errors + non-definitive responses fall
          // back to the same label below.
          if (targetId && (finalizedRef.current || targetId === deepLinked)) {
            try {
              const result = await finalizeInvitedJoin(targetId);
              if (cancelled) return;
              if (result.admitted) {
                await prepareEntry(targetId);
                if (cancelled) return;
                setPhase("admitted");
                return;
              }
              if (result.status === "rejected") {
                // Rejected — but KEEP POLLING (schedule, don't bare-return):
                // the founder can still mint a REPLACEMENT invite for this same
                // anchored company. A dead loop here would strand the tab on
                // not-approved — the fresh inviteId would never surface and the
                // re-arm below could never fire, forcing a full reload. Same
                // resource profile as `pending` (which polls forever awaiting
                // the founder); unmount cleanup stops it.
                setPhase("not_approved");
                scheduleNext();
                return;
              }
            } catch (err) {
              if (cancelled) return;
              if ((err as { status?: number }).status === 401) {
                // Session gone — back through sign-in, preserving the deep link.
                navigate(`/auth?next=${encodeURIComponent(pathname + search)}`, {
                  replace: true,
                });
                return;
              }
              // Any other error (incl. 404 = the request/invite is gone) — fall
              // back to the journey label below.
            }
          }
          if (j.journey === "returning") {
            // Approved (the invitation left the pending set and a membership now
            // exists) — or simply an existing member with nothing pending here:
            // enter the app.
            await prepareEntry(targetId);
            if (cancelled) return;
            setPhase("admitted");
            return;
          }
          // founder/no-invitation: the request was rejected or the invite died.
          // KEEP POLLING (same reasoning as the rejected branch above) — a
          // replacement invite for the anchored company can still arrive and
          // re-arm the gate, so a bare return here would force a reload too.
          setPhase("not_approved");
          scheduleNext();
          return;
        }

        // Re-arm finalize + consent when a DIFFERENT invitation surfaces for the
        // anchored company. The anchor (companyId) is stable across a
        // reject→re-invite, but the founder minting a fresh invite yields a new
        // inviteId; finalizedRef (and a latched `consented`) from the DEAD invite
        // would otherwise trap the new one out of BOTH the consent branch and the
        // finalize branch (each needs !finalizedRef), stranding the user on the
        // pending/not-approved screen until a reload. Compare the per-invite id
        // (inviteId, NOT companyId — same company across the re-invite); on change
        // drop finalizedRef and re-close the tokenless consent gate so the new
        // invitation flows through consent (filed:false) + finalize afresh. The
        // SAME invitation leaves both untouched, so finalizedRef still guards
        // against re-finalizing one invite in a loop. `consentedNow` applies the
        // reset THIS tick — the setConsented state write is not visible in this
        // closure — so a re-armed tokenless invite re-shows the consent card
        // (an explicit re-click), never an auto-finalize.
        const reArmed =
          lastInviteIdRef.current !== null && lastInviteIdRef.current !== inv.inviteId;
        if (reArmed) {
          finalizedRef.current = false;
          setConsented(false);
        }
        lastInviteIdRef.current = inv.inviteId;
        const consentedNow = reArmed ? false : consented;

        setCompany({ name: inv.companyName, role: inv.role });
        if (inv.filed === false && !consentedNow && !finalizedRef.current) {
          // Tokenlessly-detected open invite: joining requires an explicit
          // click — auto-finalize would admit the user into an org they never
          // agreed to join. Keep polling (revoke/expiry removes the invitation
          // and the branches above take over).
          setPhase("consent");
        } else if (!finalizedRef.current && targetId) {
          try {
            // The consent flag is the server-side assertion mirroring the
            // "Join {company}" click below — only the tokenless path
            // (filed === false) reaches this call post-consent; the filed
            // path carried consent at token-accept time and stays bare.
            const result = await (inv.filed === false
              ? finalizeInvitedJoin(targetId, { acceptOpenInvite: true })
              : finalizeInvitedJoin(targetId));
            if (cancelled) return;
            finalizedRef.current = true;
            if (result.admitted) {
              await prepareEntry(targetId);
              if (cancelled) return;
              setPhase("admitted");
              return;
            }
            if (result.status === "rejected") {
              // Rejected while the invite was still in the pending set — KEEP
              // POLLING so a replacement invite (fresh inviteId, same company)
              // can re-arm the gate without a reload (Codex round-13 P2).
              setPhase("not_approved");
              scheduleNext();
              return;
            }
            // invite_invalid: distinct copy (spec §9), but keep polling — the
            // founder can still approve the pending request manually.
            setPhase(result.status === "invite_invalid" ? "invite_invalid" : "pending");
          } catch (err) {
            if (cancelled) return;
            if ((err as { status?: number }).status === 401) {
              // Session gone — nothing to poll for. Back through sign-in,
              // preserving the live deep link so a successful re-auth returns
              // the user right back here.
              navigate(`/auth?next=${encodeURIComponent(pathname + search)}`, {
                replace: true,
              });
              return;
            }
            // Transient — finalizedRef stays false, so the next tick retries
            // (finalize is idempotent).
            setPhase((p) => (p === "checking" ? "pending" : p));
          }
        } else {
          setPhase((p) => (p === "invite_invalid" ? p : "pending"));
        }
      } catch (err) {
        if (cancelled) return;
        if ((err as { status?: number }).status === 401) {
          // Session gone mid-poll — nothing to poll for. Back through sign-in,
          // preserving the live deep link.
          navigate(`/auth?next=${encodeURIComponent(pathname + search)}`, {
            replace: true,
          });
          return;
        }
        setPhase((p) => (p === "checking" ? "pending" : p));
      }
      // Normal fall-through (consent / pending / invite_invalid / transient
      // error) re-arms the poll. Terminal-STOP branches (enter / 401) returned
      // above WITHOUT scheduling; the KEEP-POLLING branches (not-approved)
      // scheduled inline and returned. So exactly one schedule per tick.
      scheduleNext();
    };
    void tick();
    return () => {
      cancelled = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [prepareEntry, navigate, searchParams, pathname, search, consented]);

  if (phase === "checking") {
    return (
      <TerminalShell>
        <p className="flex items-center gap-2 text-sm text-dim">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Checking your invitation…
        </p>
      </TerminalShell>
    );
  }
  if (phase === "admitted") {
    // WS10 — the invited journey's terminal screen (spec §D7 / Journey 2): a
    // read-only company orientation panel (mission, departments, team/agent
    // counts) before landing on Home. No engine step here — the company
    // Commander is company-scoped,
    // not per-human. Rendered in the same dark shell as the founder spine
    // (`DarkShell` + `ConstellationBg`) for visual continuity.
    return (
      <DarkShell>
        <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center justify-center gap-8 px-6 py-12 text-center">
          <StepHeading
            title={`Welcome to ${company?.name ?? "the team"}.`}
            subtitle={`Here's how ${company?.name ?? "the company"} already works — you'll plug right in.`}
          />
          <CompanyOrientation companyId={anchoredTargetRef.current} companyName={company?.name ?? "the team"} />
          <Button size="lg" onClick={finishEnter}>
            {`Enter${company?.name ? ` ${company.name}` : ""}`}
          </Button>
        </div>
      </DarkShell>
    );
  }
  if (phase === "consent") {
    return (
      <TerminalShell>
        <StepHeading
          title={
            <>
              You've been invited to join{company ? ` ${company.name}` : " a company"}
              {company ? ` as ${HUMAN_ROLE_LABELS[company.role] ?? company.role}` : ""}
            </>
          }
          subtitle="Joining shares your profile with the team and gives you access to the company workspace. You'll only become a member if you choose to join."
        />
        <Button disabled={consented} onClick={() => setConsented(true)}>
          {consented ? "Joining…" : `Join${company ? ` ${company.name}` : ""}`}
        </Button>
      </TerminalShell>
    );
  }
  if (phase === "not_approved") {
    return (
      <TerminalShell>
        <StepHeading
          title="Request not approved"
          subtitle={`Your request to join${
            company ? ` ${company.name}` : ""
          } wasn't approved, or the invite is no longer valid. Ask your admin for a new invitation.`}
        />
      </TerminalShell>
    );
  }
  if (phase === "invite_invalid") {
    return (
      <TerminalShell>
        <StepHeading
          title={<>You're joining{company ? ` ${company.name}` : ""}</>}
          subtitle="Your invite link is no longer valid, but your request is with the admin for approval — this page will let you in automatically the moment it's approved."
        />
      </TerminalShell>
    );
  }
  return (
    <TerminalShell>
      <StepHeading
        title={
          <>
            You're joining{company ? ` ${company.name}` : ""}
            {company ? ` as ${HUMAN_ROLE_LABELS[company.role] ?? company.role}` : ""}
          </>
        }
        subtitle="Your request is with the admin for approval. This page will let you in automatically the moment it's approved — you can also come back later."
      />
      {/* The page polls every 7s — show that it is alive, not stuck. */}
      <p className="flex items-center justify-center gap-1.5 text-xs text-dim">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        Checking for approval…
      </p>
    </TerminalShell>
  );
}
