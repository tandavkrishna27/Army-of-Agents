import { Link } from "@/lib/router";
import { Lock, Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { CompanySkillDetail, CompanySkillUpdateStatus } from "@armyofagents/shared";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { skillSourceMeta, toneTextClass } from "@/lib/skillSourceMeta";

interface Props {
  detail: CompanySkillDetail;
  updateStatus: CompanySkillUpdateStatus | null | undefined;
  editing: boolean;
  onToggleEdit: () => void;
  onDelete: () => void;
  onCheckUpdates: () => void;
  onInstallUpdate: () => void;
  checkUpdatesPending: boolean;
  installUpdatePending: boolean;
}

function shortRef(ref: string | null | undefined): string | null {
  return ref ? ref.slice(0, 7) : null;
}

function readMetaStr(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function SkillViewerHeader({
  detail,
  updateStatus,
  editing,
  onToggleEdit,
  onDelete,
  onCheckUpdates,
  onInstallUpdate,
  checkUpdatesPending,
  installUpdatePending,
}: Props) {
  const meta = skillSourceMeta(detail.sourceBadge, detail.sourceLabel);
  const SourceIcon = meta.Icon;

  const owner = readMetaStr(detail.metadata, "owner");
  const repo = readMetaStr(detail.metadata, "repo");
  const packageId =
    (detail.sourceType === "github" || detail.sourceType === "skills_sh") && owner && repo
      ? `${owner}/${repo}`
      : null;

  const currentPin = shortRef(detail.sourceRef);
  const latestPin = shortRef(updateStatus?.latestRef);
  const usedBy = detail.usedByAgents;

  return (
    <div className="border-b border-border px-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px]">
            <SourceIcon className={cn("size-3", toneTextClass(meta.tone))} aria-hidden />
            {packageId ? (
              <Link
                to={`/skills/package/${packageId}`}
                className={cn("no-underline hover:underline", toneTextClass(meta.tone))}
              >
                {packageId}
              </Link>
            ) : (
              <span className={toneTextClass(meta.tone)}>{meta.label}</span>
            )}
            <span className="text-dim">/</span>
            <span className="text-dim">{detail.slug}</span>
            {editing && (
              <span className="text-amber-500" aria-label="Editing in progress">
                · editing
              </span>
            )}
          </div>
          <h2 className="mt-1 truncate text-[18px] font-semibold">{detail.name}</h2>
          {detail.description && (
            <p className="mt-1.5 max-w-[68ch] text-[13px] text-dim">
              {detail.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {detail.editable ? (
            <Button
              type="button"
              variant={editing ? "default" : "outline"}
              size="sm"
              onClick={onToggleEdit}
              className="h-7 gap-1.5 text-[12px]"
              aria-pressed={editing}
            >
              <Pencil className="size-3.5" />
              {editing ? "Stop editing" : "Edit"}
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded border border-border bg-white/[0.04] px-2 py-0.5 text-[10px] text-dim">
                  <Lock className="size-3" />
                  Read only · {meta.managedLabel.replace(" managed", "")}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {detail.editableReason ?? "Managed skill — update via install-update"}
              </TooltipContent>
            </Tooltip>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDelete}
            className="h-7 px-2"
            aria-label="Delete"
            title="Delete"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px] text-dim">
        <span className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.18em]">Source</span>
          <SourceIcon className={cn("size-3", toneTextClass(meta.tone))} aria-hidden />
          <span className="text-text">{meta.label}</span>
        </span>
        {detail.sourceType === "github" && currentPin && (
          <span className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.18em]">Pin</span>
            <code className="text-[11px] text-text">{currentPin}</code>
            {updateStatus?.trackingRef && (
              <>
                <span>tracking</span>
                <code className="text-[11px]">{updateStatus.trackingRef}</code>
              </>
            )}
          </span>
        )}
        {detail.sourceType === "github" && (
          <span className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.18em]">Updates</span>
            {updateStatus?.supported && updateStatus.hasUpdate ? (
              <Button
                type="button"
                size="sm"
                onClick={onInstallUpdate}
                disabled={installUpdatePending}
                className="h-6 gap-1 px-2 text-[11px]"
                aria-label="Install update"
              >
                <RefreshCw className={cn("size-3", installUpdatePending && "animate-spin")} />
                Install update {latestPin ? latestPin : ""}
              </Button>
            ) : updateStatus?.supported ? (
              <span className="inline-flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-px text-[10px] text-emerald-500">
                <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
                up to date
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onCheckUpdates}
                disabled={checkUpdatesPending}
                className="h-6 gap-1 px-2 text-[11px]"
              >
                <RefreshCw className={cn("size-3", checkUpdatesPending && "animate-spin")} />
                Check
              </Button>
            )}
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.18em]">Mode</span>
          <span>{detail.editable ? "Editable" : "Read-only"}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.18em]">Used by</span>
          {usedBy.length === 0 ? (
            <span>No agents attached</span>
          ) : (
            <span className="flex items-center gap-2">
              {usedBy.map((agent, i) => (
                <span key={agent.id} className="flex items-center gap-2">
                  {i > 0 && <span className="text-dim">·</span>}
                  <Link
                    to={`/agents/${agent.urlKey}/skills`}
                    className="text-text no-underline hover:underline"
                  >
                    {agent.name}
                  </Link>
                </span>
              ))}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
