import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { humanSocialLinkSchema } from "@armyofagents/shared";
import type { StepProps } from "../registry";
import { getUserProfile, saveUserProfile } from "../../api/userProfile";
import { advanceOnboarding } from "../../api/onboarding";
import { teamApi } from "../../api/team";
import { HUMAN_TITLE_OPTIONS, getTimezoneOptions } from "@/lib/human-profile-constants";
import { Button } from "@/components/ui/button";
import { Reveal } from "../motion";
import { FIELD, GradientText, LABEL, StepCard, StepHeading, StepShell } from "./shared";

/**
 * Shared Human Operating Profile step (spec §6). Journey-agnostic and wired
 * for BOTH journeys (founder + invited) — it superseded and replaced the bare
 * name-only ProfileStep. Runs on the user layer (companyId may be null):
 * writes the GLOBAL user profile only — the company record is materialized
 * later (invited: the approval transaction, spec §7; founder: lazily).
 * Name + Title + Timezone are required (spec decision 1); Bio + Social links
 * are optional.
 */
export function HumanProfileStep({ ctx, onComplete }: StepProps) {
  const timezoneOptions = useMemo(() => getTimezoneOptions(), []);
  const detected = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    } catch {
      return "";
    }
  }, []);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [timezone, setTimezone] = useState("");
  const [bio, setBio] = useState("");
  const [links, setLinks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Row-scoped validation error for a malformed social link, surfaced inline
  // beneath the offending row so an invalid link is fixed here — not saved,
  // advanced past, then silently dropped by materialization (Codex P2).
  const [linkError, setLinkError] = useState<{ index: number; message: string } | null>(null);

  // Prefill from the existing global profile — Name arrives from Google via the
  // auth-synced profile (spec §5: "Name is prefilled"); a returning user
  // resumes their saved values. Precedence: typed value > saved profile value >
  // browser-detected (timezone only). User-typed values are never overwritten.
  useEffect(() => {
    let cancelled = false;
    void getUserProfile()
      .then((p) => {
        if (cancelled) return;
        if (!p) {
          setTimezone((v) => v || detected);
          return;
        }
        setName((v) => v || p.displayName || "");
        setTitle((v) => v || p.title || "");
        setBio((v) => v || p.bio || "");
        setTimezone((v) => v || p.timezone || detected);
        // Restore saved social links so a returning user who revisits this
        // completed step and clicks Continue does NOT overwrite them with []
        // (silent data loss). The `prev.length ? prev :` guard preserves any
        // rows the user already typed during the async load — mirroring the
        // `(v) => v || …` precedence the scalar fields above use.
        setLinks((prev) => (prev.length ? prev : (p.socialLinks ?? []).map((l) => l.url)));
      })
      .catch(() => {
        if (!cancelled) setTimezone((v) => v || detected);
      });
    return () => {
      cancelled = true;
    };
  }, [detected]);

  const canSubmit = Boolean(name.trim() && title && timezone) && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setLinkError(null);
    // Built once and shared by BOTH the global save and the company-profile
    // sync below, so the two writes can never diverge. Each non-empty row is
    // normalized (schemeless → https) and then validated against the SAME
    // shared schema the server route + materialization use, so a link the
    // client accepts always passes the server — no split-brain — and an
    // invalid link is surfaced here instead of saved-then-dropped (Codex P2).
    const socialLinks: { type: "website"; label: null; url: string }[] = [];
    for (let i = 0; i < links.length; i++) {
      const raw = links[i].trim();
      if (!raw) continue; // empty rows are ignored (never saved)
      // Approval-time seeding validates with z.string().url() — a schemeless
      // paste (linkedin.com/in/ada) would silently vanish from the company
      // profile. Default to https, then validate the RESULT.
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
      const link = { type: "website" as const, label: null, url };
      if (!humanSocialLinkSchema.safeParse(link).success) {
        setLinkError({ index: i, message: `That doesn't look like a valid link: ${raw}` });
        setBusy(false);
        return;
      }
      socialLinks.push(link);
    }
    const profile = {
      displayName: name.trim(),
      title,
      timezone,
      bio: bio.trim() || null,
      socialLinks,
    };
    try {
      await saveUserProfile(profile);
      // Revisit path only: the central Back navigation can return the founder
      // to this step AFTER company-create with ctx.companyId set. The company-
      // scoped profile was materialized once at company-create and is otherwise
      // never refreshed, so title/bio/timezone/social edits made on the revisit
      // would stay stale on the Team page. Sync them to the member's OWN company
      // profile. The per-member PATCH permits self-edits for any role (route
      // authz: actorUserId === userId skips the founder/admin gate), so an
      // invited (non-founder) revisit cannot 403 here. On the first pass
      // (companyId null) nothing runs — the create-time materialize handles it.
      // This is an idempotent UPSERT, so it never conflicts with that seed.
      // Surfaced (not best-effort) because the user is actively editing and a
      // failure otherwise loses their edits silently, exactly as saveUserProfile
      // failures are surfaced.
      if (ctx.companyId) {
        await teamApi.updateProfile(ctx.companyId, ctx.userId, profile);
      }
      await advanceOnboarding({
        companyId: ctx.companyId,
        journey: ctx.journey,
        requestedState: "PROFILE_SET",
      });
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save your profile.");
      setBusy(false);
    }
  };

  return (
    <StepShell>
      <Reveal>
        <StepHeading
          title={
            <>
              First, <GradientText>you</GradientText>.
            </>
          }
          subtitle="AoA is humans and agents as one team — this is how your team, and its agents, will know you."
        />
      </Reveal>

      <Reveal delay={0.09}>
        <StepCard className="flex flex-col gap-3">
          <div>
            <label className={LABEL} htmlFor="hp-name">
              Name
            </label>
            <input
              id="hp-name"
              aria-label="Name"
              className={FIELD}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className={LABEL} htmlFor="hp-title">
                Title
              </label>
              <select id="hp-title" aria-label="Title" className={FIELD} value={title} onChange={(e) => setTitle(e.target.value)}>
                <option value="">Select a title…</option>
                {HUMAN_TITLE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className={LABEL} htmlFor="hp-tz">
                Timezone
              </label>
              <select id="hp-tz" aria-label="Timezone" className={FIELD} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                <option value="">Select a timezone…</option>
                {timezoneOptions.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={LABEL} htmlFor="hp-bio">
              Short bio (optional)
            </label>
            <textarea id="hp-bio" aria-label="Short bio (optional)" className={FIELD} rows={2} value={bio} onChange={(e) => setBio(e.target.value)} />
          </div>

          <div>
            <span className={LABEL}>Social links (optional)</span>
            {links.map((url, i) => (
              <div key={i}>
                <div className="mt-1 flex items-center gap-1">
                  <input
                    aria-label={`Social link ${i + 1}`}
                    className={FIELD}
                    placeholder="https://…"
                    value={url}
                    onChange={(e) => {
                      // Clear this row's inline error as the user edits it.
                      setLinkError((prev) => (prev?.index === i ? null : prev));
                      setLinks((prev) => prev.map((v, j) => (j === i ? e.target.value : v)));
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`Remove social link ${i + 1}`}
                    className="shrink-0 rounded-md p-1.5 text-dim hover:bg-white/5 hover:text-text"
                    onClick={() => {
                      // Rows shift on removal, so drop any stale row-scoped error.
                      setLinkError(null);
                      setLinks((prev) => prev.filter((_, j) => j !== i));
                    }}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
                {linkError?.index === i && (
                  <p className="mt-1 text-xs text-destructive">{linkError.message}</p>
                )}
              </div>
            ))}
            <button
              type="button"
              className="mt-1 text-xs text-dim underline"
              onClick={() => {
                setLinkError(null);
                setLinks((prev) => [...prev, ""]);
              }}
            >
              + Add link
            </button>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </StepCard>
      </Reveal>

      <Reveal delay={0.18}>
        <Button className="w-full" onClick={() => void submit()} disabled={!canSubmit}>
          {busy ? "Saving…" : "Continue"}
        </Button>
      </Reveal>
    </StepShell>
  );
}
