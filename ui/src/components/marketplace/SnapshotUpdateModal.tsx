import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "@/api/client";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MergeDiffPane } from "./MergeDiffPane";
import { useToast } from "@/context/ToastContext";
import type { SectionDiff } from "./types.js";

interface DiffResponse {
  diff: SectionDiff[];
  currentVersion: string;
  latestVersion: string;
  /** Skill updates only. Binds Apply to the exact local/upstream bytes reviewed. */
  snapshotToken?: string;
  /**
   * Agent updates only. True when the installed bundle already matches the
   * catalog byte-for-byte — the common shape of the `instructions_customized
   * IS NULL` backlog, where the row was only ever "unknown provenance" and
   * there is in fact nothing of the founder's in the way.
   */
  identical?: boolean;
}

interface SnapshotUpdateModalProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  updateId: string;
  itemName: string;
}

function defaultMergeDecisions(sections: SectionDiff[]) {
  return Object.fromEntries(
    sections.map((section) => [
      section.header,
      section.state === "added" ? "theirs" as const : "mine" as const,
    ]),
  );
}

export function SnapshotUpdateModal({
  open,
  onClose,
  companyId,
  updateId,
  itemName,
}: SnapshotUpdateModalProps) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [decisions, setDecisions] = useState<Record<string, "mine" | "theirs">>({});
  const [snapshotStale, setSnapshotStale] = useState(false);
  const [diffRevision, setDiffRevision] = useState(0);

  const {
    data: diffData,
    isLoading,
    isFetching,
    refetch: refetchDiff,
  } = useQuery<DiffResponse>({
    queryKey: ["marketplace", "updates", updateId, "diff"],
    queryFn: async () => {
      const res = await fetch(
        `/api/companies/${companyId}/marketplace/updates/${updateId}/diff`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load diff");
      return res.json() as Promise<DiffResponse>;
    },
    enabled: open,
  });

  useEffect(() => {
    setDecisions({});
    setSnapshotStale(false);
    setDiffRevision(0);
  }, [open, updateId]);

  const refreshStaleDiff = async () => {
    setSnapshotStale(true);
    setDecisions({});
    const refreshed = await refetchDiff();
    if (refreshed.isSuccess && refreshed.data) {
      // Force the stateful MergeDiffPane to rebuild its defaults even in the
      // unlikely case that content changed and then reverted to the same token.
      setDecisions(defaultMergeDecisions(refreshed.data.diff));
      setDiffRevision((revision) => revision + 1);
      setSnapshotStale(false);
      pushToast({
        title: "Merge diff refreshed",
        body: "The skill or upstream content changed. Review the refreshed diff before applying.",
        tone: "info",
      });
      return;
    }
    pushToast({
      title: "Could not refresh merge diff",
      body: "The reviewed snapshot is stale. Refresh it before trying to apply again.",
      tone: "error",
    });
  };

  const apply = useMutation({
    mutationFn: async () => {
      await api.post<{ ok: true }>(
        `/companies/${companyId}/marketplace/updates/${updateId}/merge`,
        { decisions, snapshotToken: diffData?.snapshotToken },
      );
    },
    onSuccess: () => {
      pushToast({ title: "Update applied", tone: "success" });
      qc.invalidateQueries({ queryKey: ["marketplace", "updates", companyId] });
      onClose();
    },
    onError: async (err: unknown) => {
      const body = err instanceof ApiError && err.body && typeof err.body === "object"
        ? err.body as { code?: unknown }
        : null;
      if (
        err instanceof ApiError
        && err.status === 409
        && body?.code === "SKILL_MERGE_CONFLICT"
      ) {
        await refreshStaleDiff();
        return;
      }
      pushToast({
        title: "Failed to apply merge",
        body: err instanceof Error ? err.message : "Merge failed",
        tone: "error",
      });
    },
  });
  const decisionsReady =
    !diffData
    || diffData.diff.length === 0
    || diffData.diff.every((section) => decisions[section.header] !== undefined);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Review update — {itemName}</DialogTitle>
          <DialogDescription>
            {diffData
              ? `${diffData.currentVersion} → ${diffData.latestVersion}. Choose which version of each section to keep.`
              : "Loading diff…"}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="px-0 py-4">
          {isLoading && (
            <p className="text-sm text-muted-foreground px-7">Loading changes…</p>
          )}

          {diffData?.identical && (
            <p className="px-7 pb-3 text-sm text-muted-foreground">
              No local changes found — applying this update keeps nothing back.
            </p>
          )}

          {snapshotStale && (
            <div className="mx-7 mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p>The reviewed snapshot changed. Refresh the diff before applying.</p>
              {!isFetching && (
                <Button
                  className="mt-2"
                  size="sm"
                  variant="outline"
                  onClick={() => void refreshStaleDiff()}
                >
                  Refresh diff
                </Button>
              )}
            </div>
          )}

          {diffData && (
            <MergeDiffPane
              key={`${
                diffData.snapshotToken ?? `${diffData.currentVersion}:${diffData.latestVersion}`
              }:${diffRevision}`}
              sections={diffData.diff}
              onChange={setDecisions}
            />
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => apply.mutate()}
            disabled={
              apply.isPending
              || isLoading
              || isFetching
              || snapshotStale
              || !diffData
              || !decisionsReady
            }
          >
            {apply.isPending ? "Applying…" : "Apply merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
