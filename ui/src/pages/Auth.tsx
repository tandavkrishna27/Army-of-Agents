import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { AoaLogo, ConstellationBg, usePrefersReducedMotion } from "@/onboarding/motion";
import { SplashScreen } from "@/onboarding/SplashScreen";

const SPLASH_SEEN_KEY = "aoa.splashSeen";

function hasSeenSplash(): boolean {
  try {
    return localStorage.getItem(SPLASH_SEEN_KEY) === "true";
  } catch {
    // Storage unavailable (privacy mode, disabled cookies, …) — fail toward
    // skipping the splash rather than getting a visitor stuck on it forever.
    return true;
  }
}

function markSplashSeen(): void {
  try {
    localStorage.setItem(SPLASH_SEEN_KEY, "true");
  } catch {
    // Best-effort; nothing to recover from here.
  }
}

function safeNextPath(candidate: string | null): string {
  if (!candidate?.startsWith("/")) return "/";
  if (candidate.startsWith("//") || candidate.includes("\\")) return "/";
  return candidate;
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M22.5 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-2 3.2-4.9 3.2-7.9z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.9 0 5.4-1 7.2-2.6l-3.6-2.7c-1 .7-2.3 1-3.6 1-2.8 0-5.1-1.9-6-4.4H2.3v2.8A11 11 0 0 0 12 23z"
      />
      <path fill="#FBBC05" d="M6 14.3a6.6 6.6 0 0 1 0-4.2V7.3H2.3a11 11 0 0 0 0 9.8L6 14.3z" />
      <path
        fill="#EA4335"
        d="M12 5.4c1.6 0 3 .5 4.1 1.6l3.1-3.1A11 11 0 0 0 2.3 7.3L6 10.1c.9-2.6 3.2-4.5 6-4.5z"
      />
    </svg>
  );
}

export function AuthPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const reduceMotion = usePrefersReducedMotion();
  const [splashDismissed, setSplashDismissed] = useState(false);
  const splashDecisionRef = useRef<boolean | null>(null);

  const nextPath = useMemo(() => safeNextPath(searchParams.get("next")), [searchParams]);
  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  useEffect(() => {
    if (session) {
      navigate(nextPath, { replace: true });
    }
  }, [session, navigate, nextPath]);

  // Decide once (per mount) whether to show the boot splash — synchronously
  // during render, the instant the session check resolves, so the auth card
  // never gets a chance to paint first. (An effect-driven decision would
  // render the auth card on the settling render and only swap to the splash
  // on the *next* render, producing a single-frame flash.) An
  // already-authenticated visitor — who is about to be bounced onward by the
  // effect above — never sees it flash. Skipped under reduced motion and
  // once `aoa.splashSeen` is set, so it only ever plays once per browser.
  if (!isSessionLoading && splashDecisionRef.current === null) {
    splashDecisionRef.current = !session && !reduceMotion && !hasSeenSplash();
  }
  const showSplash = splashDecisionRef.current === true && !splashDismissed;

  // bfcache guard. Clicking "Continue with Google" sets `pending` then does a
  // full-page navigation to Google, so the browser caches this page frozen on
  // the disabled "Redirecting…" button. Pressing Back restores it FROM the
  // back-forward cache without re-mounting React, so `pending` never resets and
  // the already-signed-in redirect above never re-fires — the page looks stuck.
  // On a bfcache restore (`persisted`), force a clean reload so the session is
  // re-checked and an authenticated user is bounced onward.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  // Stable across re-renders so a re-render while the splash is up can't
  // cancel/reschedule SplashScreen's completion timer (its effect depends on
  // this callback identity).
  const handleSplashDone = useCallback(() => {
    markSplashSeen();
    setSplashDismissed(true);
  }, []);

  const handleGoogle = async () => {
    setError(null);
    setPending(true);
    try {
      const { url } = await authApi.signInSocial("google", nextPath);
      if (url) {
        window.location.href = url;
        return;
      }
      setError("Could not start Google sign-in. Please try again.");
      setPending(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed");
      setPending(false);
    }
  };

  if (isSessionLoading) {
    return (
      <div
        className="onboarding-dark fixed inset-0 flex items-center justify-center"
        style={{ background: "var(--bg)" }}
      >
        <p className="text-sm" style={{ color: "var(--dim)" }}>
          Loading…
        </p>
      </div>
    );
  }

  if (showSplash) {
    return (
      <div className="onboarding-dark">
        <SplashScreen onDone={handleSplashDone} />
      </div>
    );
  }

  return (
    <div
      className="onboarding-dark fixed inset-0 flex items-center justify-center overflow-hidden px-6"
      style={{ background: "var(--bg)" }}
    >
      <ConstellationBg />

      <div className="relative z-10 flex w-full max-w-[440px] flex-col items-center gap-4 text-center">
        <AoaLogo size={96} />

        <h1
          className="text-[26px] font-bold leading-tight tracking-tight sm:text-[30px]"
          style={{ color: "var(--text)" }}
        >
          Run your{" "}
          <span
            style={{
              backgroundImage: "linear-gradient(135deg, #f1a193, var(--brand-hover), var(--amber))",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            army of agents
          </span>
        </h1>

        <p className="text-sm" style={{ color: "var(--dim)" }}>
          Your hybrid workforce — humans + AI agents — from one control room.
        </p>

        <div className="mt-2 w-full max-w-[320px] space-y-3">
          <Button onClick={handleGoogle} disabled={pending} className="w-full">
            {pending ? "Redirecting…" : (
              <>
                <GoogleIcon />
                Continue with Google
              </>
            )}
          </Button>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <p className="font-mono text-[11px]" style={{ color: "var(--very-dim)" }}>
          Signing up and signing in both happen here — Google decides which.
        </p>
      </div>
    </div>
  );
}
