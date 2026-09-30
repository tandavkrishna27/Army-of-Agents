import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { isForbidden } from "@/api/client";
import { cn } from "@/lib/utils";

export interface AccessRequiredProps {
  /**
   * The company prefix requested in the URL, when known (the membership
   * no-match case in {@link Layout}). When omitted — e.g. a mid-page 403 where
   * the client only knows a request was denied — the copy falls back to a
   * generic "this workspace".
   */
  requestedPrefix?: string | null;
  /**
   * Passthrough for embedding the surface inside an already-laid-out page (the
   * 403 case renders it in place of a page's content, within the app chrome).
   */
  className?: string;
}

/**
 * On-brand "you don't have access to this" surface.
 *
 * Composed from the shared {@link EmptyState} primitive so it reads like the
 * rest of the app. Works both as a standalone page and as a component rendered
 * inside a laid-out page (via {@link AccessRequiredBoundary}).
 *
 * The client cannot distinguish "company does not exist" from "exists but I'm
 * not a member" — both simply resolve here — so the copy covers both honestly.
 * There is deliberately NO request-access affordance in v1: joining a company
 * is invite-driven, so a request button would dead-end.
 */
export function AccessRequired({ requestedPrefix, className }: AccessRequiredProps) {
  const navigate = useNavigate();
  const target = requestedPrefix ? `“${requestedPrefix}”` : "this workspace";

  return (
    <div className={cn("flex min-h-[60vh] w-full items-center justify-center p-6", className)}>
      <EmptyState
        variant="no-results"
        icon={<Lock />}
        title="You don't have access to this"
        description={`The workspace ${target} isn't available to you. It may not exist, or you may not be a member.`}
        action={<Button onClick={() => navigate("/")}>Back to your companies</Button>}
      />
    </div>
  );
}

/**
 * Shared render-branch for company-scoped surfaces: when `error` is a 403
 * (see {@link isForbidden}) render {@link AccessRequired} instead of the page
 * content; otherwise render `children` unchanged so non-403 errors keep flowing
 * to a page's existing error handling. Mirrors the InstanceSettingsPage 403
 * panel in reusable form — deliberately NOT a broad global error boundary.
 */
export function AccessRequiredBoundary({
  error,
  children,
  className,
}: {
  error: unknown;
  children: ReactNode;
  /** Forwarded to {@link AccessRequired} when a 403 is rendered in place. */
  className?: string;
}) {
  if (isForbidden(error)) {
    return <AccessRequired className={className} />;
  }
  return <>{children}</>;
}
