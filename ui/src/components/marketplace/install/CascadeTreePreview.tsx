import { Link } from "react-router-dom";
import { Check, Plus, AlertTriangle } from "lucide-react";
import type { InstallPlan, InstallPlanStep } from "@/api/marketplace";
import { TYPE_ICONS } from "@/lib/marketplace-constants";

export interface CascadeTreePreviewProps {
  plan: InstallPlan;
  subject?: string;
}

/**
 * Render install plan's cascade as a flat ordered list (M3b.D3: 1 level only).
 * Shows: type icon, name, version, action badge ("Will install" / "Already
 * installed" / "Version mismatch"). Each row clickable → item detail page.
 *
 * The resolver returns steps in dependency order (deps first, root last).
 * We render that order as-is.
 */
export function CascadeTreePreview({ plan, subject = "team" }: CascadeTreePreviewProps) {
  return (
    <div>
      <h4 className="text-sm font-medium mb-2">Installing this {subject} will also install:</h4>
      <ul className="space-y-1 max-h-60 overflow-y-auto border rounded-md p-2">
        {plan.steps.map((step) => (
          <CascadeStepRow key={step.catalogItemId} step={step} />
        ))}
      </ul>
    </div>
  );
}

function CascadeStepRow({ step }: { step: InstallPlanStep }) {
  const Icon = TYPE_ICONS[step.itemType];

  let actionIcon: React.ReactNode;
  let actionLabel: string;
  let actionClass: string;
  if (step.action === "skip-already-installed") {
    actionIcon = <Check className="h-3 w-3" />;
    actionLabel = "Already installed";
    actionClass = "text-muted-foreground";
  } else if (step.action === "fail-version-mismatch") {
    actionIcon = <AlertTriangle className="h-3 w-3" />;
    actionLabel = "Version mismatch";
    actionClass = "text-amber-600";
  } else {
    actionIcon = <Plus className="h-3 w-3" />;
    actionLabel = "Will install";
    actionClass = "text-green-600";
  }

  // Build detail URL from catalog ID (mirrors detailUrl helper but inline since the
  // step doesn't have a full CatalogItem — just id + type)
  const colonIdx = step.catalogItemId.indexOf(":");
  const slug = step.catalogItemId.slice(colonIdx + 1);
  const href = `/marketplace/${step.itemType}/${slug}`;

  return (
    <li className="flex items-center justify-between gap-2 p-1 text-sm">
      <Link to={href} className="flex items-center gap-2 min-w-0 hover:underline">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{step.name}</span>
        <span className="text-xs text-muted-foreground">v{step.version}</span>
      </Link>
      <span className={`flex items-center gap-1 text-xs shrink-0 ${actionClass}`}>
        {actionIcon}
        <span>{actionLabel}</span>
      </span>
    </li>
  );
}
