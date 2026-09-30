import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { CatalogItem, PluginCapability } from "@armyofagents/shared";
import { PLUGIN_CAPABILITIES } from "@armyofagents/shared";
import { TrustBadge } from "../TrustBadge";
import { CapabilityConsentStep } from "./CapabilityConsentStep.js";
import { useCompany } from "@/context/CompanyContext";
import { useInstallOperation } from "@/hooks/useInstallOperation";
import { useInstallToast } from "../toast/useInstallToast";
import { useCloudPluginExecutionPolicy } from "@/hooks/useCloudPluginExecutionPolicy";

export interface PluginInstallModalProps {
  item: CatalogItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Modal for plugin install in the active company, with no implicit fallback.
 * Shows capabilities for review.
 *
 * Flow on Install click:
 *   1. Modal closes immediately
 *   2. Toast shows install progress with spinner
 *   3. Global toast provider tracks operation status
 *   4. On terminal status, toast updates and auto-dismisses
 *
 * Plugin rows are company-scoped; the selected company is the install target.
 */
export function PluginInstallModal({
  item,
  open,
  onOpenChange,
}: PluginInstallModalProps) {
  const { selectedCompanyId } = useCompany();
  const installCompanyId = selectedCompanyId;

  const installMutation = useInstallOperation({
    companyId: installCompanyId ?? "",
  });
  const { show, update, trackOperation } = useInstallToast();
  const cloudPolicy = useCloudPluginExecutionPolicy();

  const capabilities = (item.capabilities ?? [])
    .map((c) => c.id)
    .filter((id): id is PluginCapability =>
      (PLUGIN_CAPABILITIES as readonly string[]).includes(id)
    );
  const [capabilitiesAgreed, setCapabilitiesAgreed] = useState(
    capabilities.length === 0
  );

  useEffect(() => {
    setCapabilitiesAgreed(capabilities.length === 0);
  }, [item.id, capabilities.length]);

  const openedAt = useRef<Date>(new Date());
  useEffect(() => {
    if (open) openedAt.current = new Date();
  }, [open]);

  const handleInstall = async () => {
    if (!installCompanyId || cloudPolicy.controlsBlocked) return;
    const toastId = show({
      status: "installing",
      message: `Installing ${item.name}...`,
    });
    onOpenChange(false);
    try {
      const result = await installMutation.mutateAsync({
        catalogItemId: item.id,
      });
      trackOperation({
        toastId,
        companyId: installCompanyId,
        operationId: result.operationId,
        itemName: item.name,
        requestedMessage: `Request submitted - a founder will review ${item.name}`,
        invalidate: "plugins",
        startedAfter: openedAt.current,
      });
    } catch (err) {
      update(toastId, {
        status: "failure",
        message: "Failed to start install",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install {item.name}</DialogTitle>
          <DialogDescription>{item.description}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="flex items-center gap-2">
            <TrustBadge tier={item.trust.tier} />
            <Badge variant="outline" className="text-xs">
              v{item.version}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Company-scoped
            </Badge>
          </div>

          <CapabilityConsentStep
            pluginName={item.name}
            capabilities={capabilities}
            agreed={capabilitiesAgreed}
            onAgreedChange={setCapabilitiesAgreed}
          />

          <p className="text-xs text-muted-foreground">
            {cloudPolicy.isCloud
              ? "Plugin installs are unavailable on AoA Cloud until isolated workers are available."
              : "This plugin will be installed only for the active company."}
          </p>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleInstall}
            disabled={
              installMutation.isPending ||
              !installCompanyId ||
              !capabilitiesAgreed ||
              cloudPolicy.controlsBlocked
            }
          >
            {cloudPolicy.isCloud
              ? "Unavailable on AoA Cloud"
              : installMutation.isPending
                ? "Starting install..."
                : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
