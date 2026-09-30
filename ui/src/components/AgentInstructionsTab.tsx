import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { assetsApi } from "../api/assets";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { PackageFileTree, buildFileTree } from "./PackageFileTree";
import { MarkdownEditor } from "./MarkdownEditor";
import { CopyText } from "./CopyText";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/context/ToastContext";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { ChevronRight, Copy, FileText, HelpCircle, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { cn } from "../lib/utils";
import type {
  Agent,
  AgentInstructionsBundle,
  AgentInstructionsFileDetail,
} from "@armyofagents/shared";

function isMarkdown(pathValue: string) {
  return pathValue.toLowerCase().endsWith(".md");
}

function setsEqual<T>(left: Set<T>, right: Set<T>) {
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

function PromptEditorSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-[420px] w-full" />
    </div>
  );
}

export function AgentInstructionsTab({
  agent,
  companyId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
}: {
  agent: Agent;
  companyId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { isMobile } = useSidebar();
  const { pushToast } = useToast();
  const [selectedFile, setSelectedFile] = useState<string>("AGENTS.md");
  const [draft, setDraft] = useState<string | null>(null);
  const [bundleDraft, setBundleDraft] = useState<{
    mode: "managed" | "external";
    rootPath: string;
    entryFile: string;
  } | null>(null);
  const [newFilePath, setNewFilePath] = useState("");
  const [showNewFileDialog, setShowNewFileDialog] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<string[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const filePanelRef = useRef<PanelImperativeHandle>(null);
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  const [deleteFileConfirmOpen, setDeleteFileConfirmOpen] = useState(false);
  const lastFileVersionRef = useRef<string | null>(null);
  const externalBundleRef = useRef<{
    rootPath: string;
    entryFile: string;
    selectedFile: string;
  } | null>(null);

  useEffect(() => {
    setSelectedFile("AGENTS.md");
    setDraft(null);
    setBundleDraft(null);
    setNewFilePath("");
    setShowNewFileDialog(false);
    setPendingFiles([]);
    setExpandedDirs(new Set());
    setAwaitingRefresh(false);
    lastFileVersionRef.current = null;
    externalBundleRef.current = null;
  }, [agent.id]);

  const isLocal =
    agent.adapterType === "claude_local" ||
    agent.adapterType === "codex_local" ||
    agent.adapterType === "opencode_local" ||
    agent.adapterType === "hermes_local" ||
    agent.adapterType === "cursor" ||
    // AoA internal agents (Commander, Discussion Extraction) use adapterType="process"
    // but have an instructions bundle seeded via ensureWritableBundle. Detect support
    // by the presence of instructionsBundleMode in adapterConfig rather than hard-coding
    // a kind check (which would require adding kind to the Agent shared type).
    Boolean(agent.adapterConfig.instructionsBundleMode);

  const { data: bundle, isLoading: bundleLoading } = useQuery({
    queryKey: queryKeys.agents.instructionsBundle(agent.id),
    queryFn: () => agentsApi.instructionsBundle(agent.id, companyId),
    enabled: Boolean(companyId && isLocal),
  });

  const persistedMode = bundle?.mode ?? "managed";
  const persistedRootPath = persistedMode === "managed"
    ? (bundle?.managedRootPath ?? bundle?.rootPath ?? "")
    : (bundle?.rootPath ?? "");
  const currentMode = bundleDraft?.mode ?? persistedMode;
  const currentEntryFile = bundleDraft?.entryFile ?? bundle?.entryFile ?? "AGENTS.md";
  const currentRootPath = bundleDraft?.rootPath ?? persistedRootPath;
  const fileOptions = useMemo(
    () => bundle?.files.map((file) => file.path) ?? [],
    [bundle],
  );
  const bundleMatchesDraft = Boolean(
    bundle &&
    currentMode === persistedMode &&
    currentEntryFile === bundle.entryFile &&
    currentRootPath === persistedRootPath,
  );
  const visibleFilePaths = useMemo(
    () => bundleMatchesDraft
      ? [...new Set([currentEntryFile, ...fileOptions, ...pendingFiles])]
      : [currentEntryFile, ...pendingFiles],
    [bundleMatchesDraft, currentEntryFile, fileOptions, pendingFiles],
  );
  const fileTree = useMemo(
    () => buildFileTree(Object.fromEntries(visibleFilePaths.map((filePath) => [filePath, ""]))),
    [visibleFilePaths],
  );
  const selectedOrEntryFile = selectedFile || currentEntryFile;
  const selectedFileExists = bundleMatchesDraft && fileOptions.includes(selectedOrEntryFile);
  const selectedFileSummary = bundle?.files.find((file) => file.path === selectedOrEntryFile) ?? null;

  const { data: selectedFileDetail, isLoading: fileLoading } = useQuery({
    queryKey: queryKeys.agents.instructionsFile(agent.id, selectedOrEntryFile),
    queryFn: () => agentsApi.instructionsFile(agent.id, selectedOrEntryFile, companyId),
    enabled: Boolean(companyId && isLocal && selectedFileExists),
  });

  const updateBundle = useMutation({
    mutationFn: (data: {
      mode?: "managed" | "external";
      rootPath?: string | null;
      entryFile?: string;
      clearLegacyPromptTemplate?: boolean;
    }) => agentsApi.updateInstructionsBundle(agent.id, data, companyId),
    onMutate: () => setAwaitingRefresh(true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
    },
    onError: (err) => {
      setAwaitingRefresh(false);
      pushToast({ title: "Couldn't save instructions", body: err instanceof Error ? err.message : undefined, tone: "error" });
    },
  });

  const saveFile = useMutation({
    mutationFn: (data: { path: string; content: string; clearLegacyPromptTemplate?: boolean }) =>
      agentsApi.saveInstructionsFile(agent.id, data, companyId),
    onMutate: () => setAwaitingRefresh(true),
    onSuccess: (_, variables) => {
      setPendingFiles((prev) => prev.filter((f) => f !== variables.path));
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsFile(agent.id, variables.path) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
    },
    onError: (err) => {
      setAwaitingRefresh(false);
      pushToast({ title: "Couldn't save file", body: err instanceof Error ? err.message : undefined, tone: "error" });
    },
  });

  const deleteFile = useMutation({
    mutationFn: (relativePath: string) => agentsApi.deleteInstructionsFile(agent.id, relativePath, companyId),
    onMutate: () => setAwaitingRefresh(true),
    onSuccess: (_, relativePath) => {
      pushToast({ title: "File deleted", tone: "success" });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agent.id) });
      queryClient.removeQueries({ queryKey: queryKeys.agents.instructionsFile(agent.id, relativePath) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
    },
    onError: (err) => {
      setAwaitingRefresh(false);
      pushToast({ title: "Couldn't delete file", body: err instanceof Error ? err.message : undefined, tone: "error" });
    },
  });

  const uploadMarkdownImage = useMutation({
    mutationFn: async ({ file, namespace }: { file: File; namespace: string }) => {
      if (!selectedCompanyId) throw new Error("Select a company to upload images");
      return assetsApi.uploadImage(selectedCompanyId, file, namespace);
    },
  });

  useEffect(() => {
    if (!bundle) return;
    if (!bundleMatchesDraft) {
      if (selectedFile !== currentEntryFile) setSelectedFile(currentEntryFile);
      return;
    }
    const availablePaths = bundle.files.map((file) => file.path);
    if (availablePaths.length === 0) {
      if (selectedFile !== bundle.entryFile) setSelectedFile(bundle.entryFile);
      return;
    }
    if (!availablePaths.includes(selectedFile) && selectedFile !== currentEntryFile && !pendingFiles.includes(selectedFile)) {
      setSelectedFile(availablePaths.includes(bundle.entryFile) ? bundle.entryFile : availablePaths[0]!);
    }
  }, [bundle, bundleMatchesDraft, currentEntryFile, pendingFiles, selectedFile]);

  useEffect(() => {
    const nextExpanded = new Set<string>();
    for (const filePath of visibleFilePaths) {
      const parts = filePath.split("/");
      let currentPath = "";
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i]!;
        nextExpanded.add(currentPath);
      }
    }
    setExpandedDirs((current) => (setsEqual(current, nextExpanded) ? current : nextExpanded));
  }, [visibleFilePaths]);

  useEffect(() => {
    const versionKey = selectedFileExists && selectedFileDetail
      ? `${selectedFileDetail.path}:${selectedFileDetail.content}`
      : `draft:${currentMode}:${currentRootPath}:${selectedOrEntryFile}`;
    if (awaitingRefresh) {
      setAwaitingRefresh(false);
      setBundleDraft(null);
      setDraft(null);
      lastFileVersionRef.current = versionKey;
      return;
    }
    if (lastFileVersionRef.current !== versionKey) {
      setDraft(null);
      lastFileVersionRef.current = versionKey;
    }
  }, [awaitingRefresh, currentMode, currentRootPath, selectedFileDetail, selectedFileExists, selectedOrEntryFile]);

  useEffect(() => {
    if (!bundle) return;
    setBundleDraft((current) => {
      if (current) return current;
      return {
        mode: persistedMode,
        rootPath: persistedRootPath,
        entryFile: bundle.entryFile,
      };
    });
  }, [bundle, persistedMode, persistedRootPath]);

  useEffect(() => {
    if (!bundle || currentMode !== "external") return;
    externalBundleRef.current = {
      rootPath: currentRootPath,
      entryFile: currentEntryFile,
      selectedFile: selectedOrEntryFile,
    };
  }, [bundle, currentEntryFile, currentMode, currentRootPath, selectedOrEntryFile]);

  const currentContent = selectedFileExists ? (selectedFileDetail?.content ?? "") : "";
  const displayValue = draft ?? currentContent;
  const bundleDirty = Boolean(
    bundleDraft &&
      (
        bundleDraft.mode !== persistedMode ||
        bundleDraft.rootPath !== persistedRootPath ||
        bundleDraft.entryFile !== (bundle?.entryFile ?? "AGENTS.md")
      ),
  );
  const fileDirty = draft !== null && draft !== currentContent;
  const isDirty = bundleDirty || fileDirty;
  const isSaving = updateBundle.isPending || saveFile.isPending || deleteFile.isPending || awaitingRefresh;

  useEffect(() => { onSavingChange(isSaving); }, [onSavingChange, isSaving]);
  useEffect(() => { onDirtyChange(isDirty); }, [onDirtyChange, isDirty]);

  const handleInstrSave = useCallback(() => {
    const save = async () => {
      const shouldClearLegacy =
        Boolean(bundle?.legacyPromptTemplateActive) || Boolean(bundle?.legacyBootstrapPromptTemplateActive);
      if (bundleDirty && bundleDraft) {
        await updateBundle.mutateAsync({
          mode: bundleDraft.mode,
          rootPath: bundleDraft.mode === "external" ? bundleDraft.rootPath : null,
          entryFile: bundleDraft.entryFile,
        });
      }
      if (fileDirty) {
        await saveFile.mutateAsync({
          path: selectedOrEntryFile,
          content: displayValue,
          clearLegacyPromptTemplate: shouldClearLegacy,
        });
      }
    };
    void save().catch(() => undefined);
  }, [
    bundle,
    bundleDirty,
    bundleDraft,
    displayValue,
    fileDirty,
    saveFile,
    selectedOrEntryFile,
    updateBundle,
  ]);

  const handleInstrCancel = useCallback(() => {
    setDraft(null);
    if (bundle) {
      setBundleDraft({
        mode: persistedMode,
        rootPath: persistedRootPath,
        entryFile: bundle.entryFile,
      });
    }
  }, [bundle, persistedMode, persistedRootPath]);

  useEffect(() => {
    onSaveActionChange(isDirty ? handleInstrSave : null);
  }, [isDirty, handleInstrSave, onSaveActionChange]);

  useEffect(() => {
    onCancelActionChange(isDirty ? handleInstrCancel : null);
  }, [isDirty, handleInstrCancel, onCancelActionChange]);

  const selectFile = (filePath: string) => {
    setSelectedFile(filePath);
    if (!fileOptions.includes(filePath)) setDraft("");
  };

  const handleCreateFile = () => {
    const candidate = newFilePath.trim();
    if (!candidate || candidate.includes("..") || visibleFilePaths.includes(candidate)) return;
    setPendingFiles((prev) => (prev.includes(candidate) ? prev : [...prev, candidate]));
    setSelectedFile(candidate);
    setDraft("");
    setNewFilePath("");
    setShowNewFileDialog(false);
  };

  if (!isLocal) {
    return (
      <div className="max-w-3xl">
        <p className="text-sm text-muted-foreground">
          Instructions bundles are only available for local adapters.
        </p>
      </div>
    );
  }

  if (bundleLoading && !bundle) {
    return <AgentInstructionsTabSkeleton />;
  }

  const fileTreeNode = (
    <PackageFileTree
      nodes={fileTree}
      selectedFile={selectedOrEntryFile}
      expandedDirs={expandedDirs}
      checkedFiles={new Set()}
      onToggleDir={(dirPath) => setExpandedDirs((current) => {
        const next = new Set(current);
        if (next.has(dirPath)) next.delete(dirPath);
        else next.add(dirPath);
        return next;
      })}
      onSelectFile={selectFile}
      onToggleCheck={() => {}}
      showCheckboxes={false}
      renderFileExtra={(node) => {
        const file = bundle?.files.find((entry) => entry.path === node.path);
        if (!file) return null;
        if (file.deprecated) {
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="ml-3 shrink-0 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide cursor-help">
                  virtual file
                </span>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={4}>
                Legacy inline prompt — this deprecated virtual file preserves the old promptTemplate content
              </TooltipContent>
            </Tooltip>
          );
        }
        return (
          <span className="ml-3 shrink-0 rounded border border-border text-muted-foreground px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
            {file.isEntryFile ? "entry" : `${file.size}b`}
          </span>
        );
      }}
    />
  );

  const editorPane = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-medium font-mono truncate">{selectedOrEntryFile}</h4>
          <p className="text-xs text-muted-foreground">
            {selectedFileExists
              ? selectedFileSummary?.deprecated
                ? "Deprecated virtual file"
                : `${selectedFileDetail?.language ?? "text"} file`
              : "New file in this bundle"}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isDirty && (
            <>
              <Button type="button" size="sm" variant="ghost" onClick={handleInstrCancel} disabled={isSaving}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={handleInstrSave} disabled={isSaving}>
                {isSaving ? "Saving…" : "Save"}
              </Button>
            </>
          )}
          {selectedFileExists && !selectedFileSummary?.deprecated && selectedOrEntryFile !== currentEntryFile && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setDeleteFileConfirmOpen(true)}
              disabled={deleteFile.isPending}
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      {selectedFileExists && fileLoading && !selectedFileDetail ? (
        <PromptEditorSkeleton />
      ) : isMarkdown(selectedOrEntryFile) ? (
        <MarkdownEditor
          key={selectedOrEntryFile}
          value={displayValue}
          onChange={(value) => setDraft(value ?? "")}
          placeholder="# Agent instructions"
          contentClassName="min-h-[60vh] text-sm font-mono"
          imageUploadHandler={async (file) => {
            const namespace = `agents/${agent.id}/instructions/${selectedOrEntryFile.replaceAll("/", "-")}`;
            const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
            return asset.contentPath;
          }}
        />
      ) : (
        <textarea
          value={displayValue}
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-[60vh] w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-sm outline-none"
          placeholder="File contents"
        />
      )}
    </>
  );

  return (
    <div className="max-w-[1400px] space-y-6">
      {(bundle?.warnings ?? []).length > 0 && (
        <div className="space-y-2">
          {(bundle?.warnings ?? []).map((warning) => (
            <div key={warning} className="rounded-md border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-xs text-sky-100">
              {warning}
            </div>
          ))}
        </div>
      )}

      <Collapsible defaultOpen={currentMode === "external"}>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors group">
          <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4 pb-6">
          <TooltipProvider>
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-[auto_1fr_1fr]">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  Mode
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={4}>
                      Managed: AoA stores and serves the instructions bundle. External: you provide a path on disk where the instructions live.
                    </TooltipContent>
                  </Tooltip>
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={currentMode === "managed" ? "default" : "outline"}
                    onClick={() => {
                      if (currentMode === "external") {
                        externalBundleRef.current = {
                          rootPath: currentRootPath,
                          entryFile: currentEntryFile,
                          selectedFile: selectedOrEntryFile,
                        };
                      }
                      const nextEntryFile = currentEntryFile || "AGENTS.md";
                      setBundleDraft({
                        mode: "managed",
                        rootPath: bundle?.managedRootPath ?? currentRootPath,
                        entryFile: nextEntryFile,
                      });
                      setSelectedFile(nextEntryFile);
                    }}
                  >
                    Managed
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={currentMode === "external" ? "default" : "outline"}
                    onClick={() => {
                      const externalBundle = externalBundleRef.current;
                      const nextEntryFile = externalBundle?.entryFile ?? currentEntryFile ?? "AGENTS.md";
                      setBundleDraft({
                        mode: "external",
                        rootPath: externalBundle?.rootPath ?? (bundle?.mode === "external" ? (bundle.rootPath ?? "") : ""),
                        entryFile: nextEntryFile,
                      });
                      setSelectedFile(externalBundle?.selectedFile ?? nextEntryFile);
                    }}
                  >
                    External
                  </Button>
                </div>
              </label>
              <label className="space-y-1.5 min-w-0">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  Root path
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={4}>
                      The absolute directory on disk where the instructions bundle lives. In managed mode this is set by AoA automatically.
                    </TooltipContent>
                  </Tooltip>
                </span>
                {currentMode === "managed" ? (
                  <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground pt-1.5">
                    <span className="min-w-0 truncate" title={currentRootPath || undefined}>{currentRootPath || "(managed)"}</span>
                    {currentRootPath && (
                      <CopyText text={currentRootPath} className="shrink-0">
                        <Copy className="h-3.5 w-3.5" />
                      </CopyText>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={currentRootPath}
                      onChange={(event) => {
                        const nextRootPath = event.target.value;
                        externalBundleRef.current = {
                          rootPath: nextRootPath,
                          entryFile: currentEntryFile,
                          selectedFile: selectedOrEntryFile,
                        };
                        setBundleDraft({
                          mode: "external",
                          rootPath: nextRootPath,
                          entryFile: currentEntryFile,
                        });
                      }}
                      className="font-mono text-sm"
                      placeholder="/absolute/path/to/agent/prompts"
                    />
                    {currentRootPath && (
                      <CopyText text={currentRootPath} className="shrink-0">
                        <Copy className="h-3.5 w-3.5" />
                      </CopyText>
                    )}
                  </div>
                )}
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  Entry file
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={4}>
                      The main file the agent reads first when loading instructions. Defaults to AGENTS.md.
                    </TooltipContent>
                  </Tooltip>
                </span>
                <Input
                  value={currentEntryFile}
                  onChange={(event) => {
                    const nextEntryFile = event.target.value || "AGENTS.md";
                    const nextSelectedFile = selectedOrEntryFile === currentEntryFile
                      ? nextEntryFile
                      : selectedOrEntryFile;
                    if (currentMode === "external") {
                      externalBundleRef.current = {
                        rootPath: currentRootPath,
                        entryFile: nextEntryFile,
                        selectedFile: nextSelectedFile,
                      };
                    }
                    if (selectedOrEntryFile === currentEntryFile) setSelectedFile(nextEntryFile);
                    setBundleDraft({
                      mode: currentMode,
                      rootPath: currentRootPath,
                      entryFile: nextEntryFile,
                    });
                  }}
                  className="font-mono text-sm"
                />
              </label>
            </div>
          </TooltipProvider>
        </CollapsibleContent>
      </Collapsible>

      {isMobile ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-border">
            <div className="flex h-[42px] items-center justify-between border-b border-border pl-3 pr-1.5">
              <h4 className="text-sm font-medium">Files</h4>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-7 w-7"
                onClick={() => setShowNewFileDialog(true)}
                aria-label="Add file"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="max-h-[40vh] overflow-auto p-2">{fileTreeNode}</div>
          </div>
          <div className="rounded-lg border border-border p-4 space-y-3">{editorPane}</div>
        </div>
      ) : (
        <div className="h-[calc(100vh-16rem)] min-h-[460px]">
          <Group orientation="horizontal" className="h-full gap-2">
            <Panel
              id="instr-files"
              defaultSize="24%"
              minSize="14%"
              maxSize="42%"
              collapsible
              collapsedSize="5%"
              panelRef={filePanelRef}
              onResize={(s) => setFilesCollapsed(s.asPercentage <= 8)}
              className="h-full overflow-hidden min-w-0"
            >
              <div className="h-full overflow-hidden rounded-xl border border-border bg-background">
                {filesCollapsed ? (
                  <aside className="flex h-full w-full flex-col items-center bg-card">
                    <div className="flex h-[42px] w-full shrink-0 items-center justify-center border-b border-border">
                      <button
                        type="button"
                        onClick={() => filePanelRef.current?.expand()}
                        title="Expand"
                        aria-label="Expand files nav"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                      >
                        <PanelLeftOpen className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="flex flex-1 flex-col items-center gap-1 overflow-auto py-2">
                      <button
                        type="button"
                        onClick={() => setShowNewFileDialog(true)}
                        title="Add file"
                        aria-label="Add file"
                        className="flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                      >
                        <Plus className="size-4" />
                      </button>
                      <div className="my-1 h-px w-6 bg-border" />
                      {visibleFilePaths.map((path) => {
                        const active = selectedOrEntryFile === path;
                        const isEntry = path === currentEntryFile;
                        return (
                          <button
                            key={path}
                            type="button"
                            onClick={() => selectFile(path)}
                            title={path}
                            aria-label={path}
                            className={cn(
                              "relative flex size-10 items-center justify-center rounded-md transition-colors",
                              active
                                ? "bg-accent text-accent-foreground"
                                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                            )}
                          >
                            <FileText className="size-4" />
                            {isEntry && <span className="absolute bottom-1 right-1 size-1.5 rounded-full bg-primary" />}
                          </button>
                        );
                      })}
                    </div>
                  </aside>
                ) : (
                  <div className="flex h-full flex-col">
                    <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-border pl-3 pr-1.5">
                      <h4 className="text-sm font-medium">Files</h4>
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => setShowNewFileDialog(true)}
                          title="Add file"
                          aria-label="Add file"
                          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => filePanelRef.current?.collapse()}
                          title="Collapse"
                          aria-label="Collapse files nav"
                          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                        >
                          <PanelLeftClose className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    <div className="flex-1 overflow-auto p-2">{fileTreeNode}</div>
                  </div>
                )}
              </div>
            </Panel>
            <Separator className="w-1 shrink-0 cursor-col-resize rounded bg-transparent hover:bg-border/70 transition-colors" />
            <Panel className="h-full overflow-hidden min-w-0">
              <div className="h-full overflow-auto rounded-xl border border-border bg-background p-4 space-y-3">
                {editorPane}
              </div>
            </Panel>
          </Group>
        </div>
      )}

      <Dialog
        open={showNewFileDialog}
        onOpenChange={(open) => {
          setShowNewFileDialog(open);
          if (!open) setNewFilePath("");
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add file</DialogTitle>
            <DialogDescription>
              Create a new file in this instructions bundle. It’s saved when you save the file’s contents.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-2">
            <Input
              value={newFilePath}
              onChange={(event) => setNewFilePath(event.target.value)}
              placeholder="TOOLS.md"
              className="font-mono text-sm"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleCreateFile();
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              Markdown (<code>.md</code>) files render in the rich editor. Use a relative path like{" "}
              <code>docs/STYLE.md</code> to nest.
            </p>
            {newFilePath.trim() && visibleFilePaths.includes(newFilePath.trim()) && (
              <p className="text-xs text-amber-400">A file with that path already exists.</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShowNewFileDialog(false);
                setNewFilePath("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleCreateFile}
              disabled={
                !newFilePath.trim() ||
                newFilePath.includes("..") ||
                visibleFilePaths.includes(newFilePath.trim())
              }
            >
              Create file
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteFileConfirmOpen}
        onOpenChange={setDeleteFileConfirmOpen}
        title={`Delete ${selectedOrEntryFile}?`}
        confirmLabel="Delete"
        onConfirm={() => {
          deleteFile.mutate(selectedOrEntryFile, {
            onSuccess: () => {
              setSelectedFile(currentEntryFile);
              setDraft(null);
            },
          });
          setDeleteFileConfirmOpen(false);
        }}
      />
    </div>
  );
}

export function AgentInstructionsTabSkeleton() {
  return (
    <div className="max-w-5xl space-y-4">
      <Skeleton className="h-6 w-32" />
      <div className="flex gap-4">
        <Skeleton className="h-[500px] w-[260px] shrink-0" />
        <Skeleton className="h-[500px] flex-1" />
      </div>
    </div>
  );
}
