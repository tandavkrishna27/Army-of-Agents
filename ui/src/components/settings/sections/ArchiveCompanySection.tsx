import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { companiesApi } from "@/api/companies";
import { queryKeys } from "@/lib/queryKeys";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function ArchiveCompanySection() {
  const { companies, selectedCompany, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const archiveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      await companiesApi.archive(selectedCompanyId);
      return {
        nextCompanyId:
          companies.find(
            (c) => c.id !== selectedCompanyId && c.status !== "archived",
          )?.id ?? null,
      };
    },
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) setSelectedCompanyId(nextCompanyId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      navigate("/");
    },
  });

  const isArchived = selectedCompany?.status === "archived";

  return (
    <div>
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Danger
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          Archive company<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Soft-delete the company. Reversible by an admin. Stops new heartbeats and freezes spend.
        </p>
      </div>
      <div className="p-8 max-w-[680px]">
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 space-y-3">
          <div>
            <p className="text-sm font-medium">
              Archive {selectedCompany?.name ?? "this company"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              All running heartbeats stop. Tasks, agents, goals, memory, artifacts are preserved
              but read-only. You'll be returned to the lobby.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={archiveMutation.isPending || isArchived}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-destructive hover:bg-destructive/90 text-destructive-foreground text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {archiveMutation.isPending
              ? "Archiving..."
              : isArchived
                ? "Already archived"
                : "Archive company"}
          </button>
          {archiveMutation.isError && (
            <span className="text-xs text-destructive">
              {archiveMutation.error instanceof Error
                ? archiveMutation.error.message
                : "Failed to archive company"}
            </span>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={
          selectedCompany ? `Archive company "${selectedCompany.name}"?` : "Archive company?"
        }
        description="It will be hidden from the sidebar. Reversible by an admin."
        confirmLabel="Archive"
        destructive
        onConfirm={() => {
          archiveMutation.mutate();
          setConfirmOpen(false);
        }}
      />
    </div>
  );
}
