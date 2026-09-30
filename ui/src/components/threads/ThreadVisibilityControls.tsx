import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  THREAD_VISIBILITIES,
  type ThreadVisibility,
} from "@armyofagents/shared";
import { threadsApi, type ThreadDetail } from "../../api/threads";
import { useToast } from "../../context/ToastContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Lock,
  Copy,
  Link as LinkIcon,
  Globe,
  Building2,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";

/* ════════════════════════════════════════════════════════════════════════
   ThreadVisibilityControls
   Per-thread visibility selector (Private / Department / Company) + the
   founder-only public share-link block. Lifted verbatim out of the retired
   OriginCard so it can mount in the redesigned thread header.

   Company-scoped: every API call is `threadsApi.<x>(companyId, thread.id, …)`,
   so the parent must pass the resolved companyId.
   ════════════════════════════════════════════════════════════════════════ */

interface ThreadVisibilityControlsProps {
  thread: ThreadDetail;
  companyId: string;
}

const VISIBILITY_META: Record<
  ThreadVisibility,
  { label: string; Icon: LucideIcon }
> = {
  private: { label: "Private", Icon: Lock },
  department: { label: "Department", Icon: Building2 },
  company: { label: "Company", Icon: Globe },
};

export function ThreadVisibilityControls({
  thread,
  companyId,
}: ThreadVisibilityControlsProps) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [shareBusy, setShareBusy] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["threads", companyId, thread.id] });

  // Phase 1 Phase E batch 2 (T22): full 3-option visibility selector
  // (private | department | company). The legacy binary toggle was dropped —
  // dept-scoped UI is now reachable directly from the dropdown.
  const visibilityMutation = useMutation({
    mutationFn: (visibility: ThreadVisibility) =>
      threadsApi.setVisibility(companyId, thread.id, visibility),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Visibility updated", tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to update visibility", tone: "warn" });
    },
  });

  function handleVisibilityChange(next: ThreadVisibility) {
    if (next === thread.visibility) return;
    visibilityMutation.mutate(next);
  }

  // Share-link URL — assembled client-side from the current host. Server
  // returns just the token; the URL shape (`/discussions/<id>?token=<t>`)
  // matches the public read-only viewer route.
  const shareUrl = thread.shareToken
    ? `${typeof window === "undefined" ? "" : window.location.origin}/discussions/${thread.id}?token=${thread.shareToken}`
    : null;

  async function handleGenerateShareToken() {
    if (shareBusy) return;
    setShareBusy(true);
    try {
      await threadsApi.generateShareToken(companyId, thread.id);
      invalidate();
      pushToast({ title: "Share link generated", tone: "success" });
    } catch {
      pushToast({ title: "Failed to generate share link", tone: "warn" });
    } finally {
      setShareBusy(false);
    }
  }

  async function handleRevokeShareToken() {
    if (shareBusy) return;
    setShareBusy(true);
    try {
      await threadsApi.revokeShareToken(companyId, thread.id);
      invalidate();
      pushToast({ title: "Share link revoked", tone: "success" });
    } catch {
      pushToast({ title: "Failed to revoke share link", tone: "warn" });
    } finally {
      setShareBusy(false);
    }
  }

  async function handleCopyShareUrl() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard?.writeText(shareUrl);
      pushToast({ title: "Share link copied", tone: "success" });
    } catch {
      pushToast({ title: "Couldn't copy share link", tone: "warn" });
    }
  }

  const VisibilityIcon = VISIBILITY_META[thread.visibility].Icon;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Phase E batch 2 (T22): 3-option visibility dropdown
          (Private / Department / Company). Replaces the legacy binary
          toggle. Still surfaces a data-testid for back-compat with the
          upgraded test suite. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="visibility-selector"
            disabled={visibilityMutation.isPending}
            aria-label={`Visibility: ${VISIBILITY_META[thread.visibility].label}`}
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] border border-border hover:bg-muted/30 transition-colors capitalize"
          >
            <VisibilityIcon className="h-2.5 w-2.5" />
            {VISIBILITY_META[thread.visibility].label}
            <ChevronDown className="h-2.5 w-2.5 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid="visibility-menu">
          <DropdownMenuRadioGroup
            value={thread.visibility}
            onValueChange={(value) =>
              handleVisibilityChange(value as ThreadVisibility)
            }
          >
            {THREAD_VISIBILITIES.map((v) => {
              const meta = VISIBILITY_META[v];
              const Icon = meta.Icon;
              return (
                <DropdownMenuRadioItem
                  key={v}
                  value={v}
                  data-testid={`visibility-option-${v}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Icon className="h-3 w-3" />
                    {meta.label}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Phase E batch 2 (T22): share-link toggle + token display.
          Founder-only flow. When no token exists, surface a single
          "Generate share link" button. When a token exists, show the URL +
          copy + revoke. */}
      <div
        className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border bg-muted/10 px-2.5 py-2"
        data-testid="share-link-block"
      >
        <LinkIcon className="h-3 w-3 text-muted-foreground shrink-0" aria-hidden />
        {!thread.shareToken ? (
          <>
            <span className="text-[11px] text-muted-foreground">
              Public share link: off
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px] ml-auto"
              disabled={shareBusy}
              onClick={() => void handleGenerateShareToken()}
              data-testid="generate-share-token"
            >
              Generate share link
            </Button>
          </>
        ) : (
          <>
            <code
              className="truncate font-mono text-[11px] text-foreground"
              data-testid="share-link-url"
              title={shareUrl ?? ""}
            >
              {shareUrl}
            </code>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => void handleCopyShareUrl()}
                data-testid="copy-share-token"
                aria-label="Copy share link"
              >
                <Copy className="h-3 w-3" />
                Copy
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px] text-destructive hover:text-destructive"
                disabled={shareBusy}
                onClick={() => void handleRevokeShareToken()}
                data-testid="revoke-share-token"
              >
                Revoke
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
