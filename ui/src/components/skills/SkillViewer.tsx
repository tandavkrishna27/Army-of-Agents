// ui/src/components/skills/SkillViewer.tsx
import { useEffect, useState } from "react";
import type {
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillUpdateStatus,
} from "@armyofagents/shared";
import { PageSkeleton } from "../PageSkeleton";
import { SkillViewerHeader } from "./SkillViewerHeader";
import { SkillFilePathStrip } from "./SkillFilePathStrip";
import { SkillFileTree } from "./SkillFileTree";
import { SkillBody } from "./SkillBody";

type ViewMode = "preview" | "code";

interface Props {
  detail: CompanySkillDetail;
  file: CompanySkillFileDetail | null;
  fileLoading: boolean;
  selectedPath: string;
  updateStatus: CompanySkillUpdateStatus | null | undefined;
  onSelectPath: (path: string) => void;
  onCheckUpdates: () => void;
  onInstallUpdate: () => void;
  checkUpdatesPending: boolean;
  installUpdatePending: boolean;
  onSave: (markdown: string) => void;
  savePending: boolean;
  onDelete: () => void;
}

function splitFrontmatterBody(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return normalized;
  return normalized.slice(closing + 5).trimStart();
}

function externalUrlForFile(detail: CompanySkillDetail, path: string): string | undefined {
  const meta = detail.metadata && typeof detail.metadata === "object" ? detail.metadata : null;
  const owner = typeof meta?.["owner"] === "string" ? (meta["owner"] as string) : null;
  const repo = typeof meta?.["repo"] === "string" ? (meta["repo"] as string) : null;
  const skillPath =
    typeof meta?.["skillPath"] === "string" ? (meta["skillPath"] as string) : "";
  if (detail.sourceType !== "github" || !owner || !repo) return undefined;
  const ref = detail.sourceRef ?? "main";
  const prefix = skillPath ? `${skillPath.replace(/\/+$/, "")}/` : "";
  return `https://github.com/${owner}/${repo}/blob/${ref}/${prefix}${path}`;
}

export function SkillViewer({
  detail,
  file,
  fileLoading,
  selectedPath,
  updateStatus,
  onSelectPath,
  onCheckUpdates,
  onInstallUpdate,
  checkUpdatesPending,
  installUpdatePending,
  onSave,
  savePending,
  onDelete,
}: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [treeExpanded, setTreeExpanded] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  // Auto-exit edit mode + reset draft when file changes
  useEffect(() => {
    setEditing(false);
    if (file) {
      setDraft(file.markdown ? splitFrontmatterBody(file.content) : file.content);
    }
  }, [selectedPath, file?.content, file?.markdown]);

  // Auto-collapse tree when path changes via tree click
  useEffect(() => {
    setTreeExpanded(false);
  }, [selectedPath]);

  const fileCount = detail.fileInventory.length;
  const externalUrl = file ? externalUrlForFile(detail, file.path) : undefined;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <SkillViewerHeader
        detail={detail}
        updateStatus={updateStatus}
        editing={editing}
        onToggleEdit={() => setEditing((v) => !v)}
        onDelete={onDelete}
        onCheckUpdates={onCheckUpdates}
        onInstallUpdate={onInstallUpdate}
        checkUpdatesPending={checkUpdatesPending}
        installUpdatePending={installUpdatePending}
      />

      <SkillFilePathStrip
        filePath={file?.path ?? selectedPath}
        fileCount={fileCount}
        treeExpanded={treeExpanded}
        viewMode={viewMode}
        editing={editing}
        hasUnsavedChanges={
          editing && file !== null && draft !== splitFrontmatterBody(file.content)
        }
        savePending={savePending}
        onToggleTree={() => setTreeExpanded((v) => !v)}
        onViewMode={setViewMode}
        onSave={() => onSave(draft)}
        onCancel={() => setEditing(false)}
      />

      {treeExpanded && fileCount > 1 && (
        <SkillFileTree
          inventory={detail.fileInventory}
          selectedPath={selectedPath}
          expandedDirs={expandedDirs}
          onToggleDir={(dir) => {
            setExpandedDirs((cur) => {
              const next = new Set(cur);
              if (next.has(dir)) next.delete(dir);
              else next.add(dir);
              return next;
            });
          }}
          onSelect={(path) => {
            onSelectPath(path);
            setTreeExpanded(false);
          }}
        />
      )}

      <div className="flex-1 overflow-auto">
        {fileLoading && !file ? (
          <PageSkeleton variant="detail" />
        ) : (
          <SkillBody
            file={file}
            editing={editing}
            viewMode={viewMode}
            draft={draft}
            onDraftChange={setDraft}
            externalUrl={externalUrl}
          />
        )}
      </div>
    </div>
  );
}
