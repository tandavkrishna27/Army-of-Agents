import { useEffect, useMemo, useState } from "react";
import type { MarketplaceCatalogItem, MarketplacePackage } from "@armyofagents/shared";
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
import { useCompany } from "@/context/CompanyContext";
import { useInstallOperation } from "@/hooks/useInstallOperation";
import { ProviderLogo } from "../ProviderLogo";
import { CompanyPicker } from "./CompanyPicker";
import { useInstallToast } from "../toast/useInstallToast";

export interface PackageInstallModalProps {
  pkg: MarketplacePackage | null;
  memberItems: MarketplaceCatalogItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PackageInstallModal({
  pkg,
  memberItems,
  open,
  onOpenChange,
}: PackageInstallModalProps) {
  const { selectedCompanyId, companies } = useCompany();
  const [companyId, setCompanyId] = useState<string | null>(selectedCompanyId);
  const installMutation = useInstallOperation({ companyId: companyId ?? "" });
  const { show, update, trackOperation } = useInstallToast();

  const activeCompanies = useMemo(
    () => companies.filter((c) => c.status !== "archived"),
    [companies],
  );

  useEffect(() => {
    if (!companyId) {
      const fallback = selectedCompanyId ?? activeCompanies[0]?.id ?? null;
      if (fallback) setCompanyId(fallback);
    }
  }, [companyId, selectedCompanyId, activeCompanies]);

  const skillCount = useMemo(
    () => memberItems.filter((item) => item.type === "skill").length,
    [memberItems],
  );

  const canInstall = !!pkg && !!companyId && memberItems.length > 0 && skillCount === memberItems.length;

  const handleInstall = async () => {
    if (!canInstall || !pkg || !companyId) return;
    const toastId = show({ status: "installing", message: `Installing ${pkg.name}...` });
    onOpenChange(false);
    try {
      const result = await installMutation.mutateAsync({
        packageId: pkg.id,
        catalogItemIds: memberItems.map((item) => item.id),
      });
      trackOperation({
        toastId,
        companyId,
        operationId: result.operationId,
        itemName: pkg.name,
        invalidate: "companySkills",
      });
    } catch (err) {
      update(toastId, {
        status: "failure",
        message: "Failed to start install",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (!pkg) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Install skills</DialogTitle>
          <DialogDescription>{pkg.name}</DialogDescription>
        </DialogHeader>

        <DialogBody className="min-w-0 space-y-4 overflow-x-hidden">
          <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-3">
            <ProviderLogo provider={pkg.provider} className="size-11 shrink-0 rounded-xl" />
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{pkg.name}</div>
              <div className="text-xs text-very-dim">
                {skillCount} {skillCount === 1 ? "skill" : "skills"}
              </div>
            </div>
          </div>

          <CompanyPicker value={companyId} onChange={setCompanyId} />

          {activeCompanies.length === 0 && (
            <div className="text-sm text-destructive">
              No organization available — create or join a company to install skills.
            </div>
          )}

          <div className="max-h-[38vh] min-w-0 space-y-1.5 overflow-y-auto overflow-x-hidden pr-1">
            {memberItems.map((item) => (
              <div
                key={item.id}
                className="flex w-full min-w-0 items-center justify-between gap-3 overflow-hidden rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{item.name}</div>
                  <div className="truncate text-xs text-very-dim">{item.description}</div>
                </div>
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-very-dim">
                  {item.type}
                </span>
              </div>
            ))}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleInstall} disabled={!canInstall || installMutation.isPending}>
            {installMutation.isPending
              ? "Starting install..."
              : `Install all ${skillCount} ${skillCount === 1 ? "skill" : "skills"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
