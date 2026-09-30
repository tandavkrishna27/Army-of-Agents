import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { memoryAssetsApi } from "../../api/memoryAssets";
import { projectsApi } from "../../api/projects";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";

interface MemoryUploadButtonProps {
  companyId: string;
  departmentId: string | null;
  folderPath: string;
  iconOnly?: boolean;
}

export function MemoryUploadButton({
  companyId,
  departmentId,
  folderPath,
  iconOnly = false,
}: MemoryUploadButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const { pushToast } = useToast();

  // Phase 6.2 follow-up (Codex P1): in dept-only mode the explorer sets
  // `folderPath = ""` and `departmentId = "<id>"`, but the central pane's
  // strict-path filter (`folderPath === deptSlug`) only shows assets stored
  // at `<deptSlug>`. Look up the dept slug here so uploads from the dept
  // root land where the listing filter can see them. Cached via react-query
  // — `MemoryFileList` reads the same key, so this is a cache hit.
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: Boolean(companyId) && Boolean(departmentId) && !folderPath,
  });
  const deptSlug = departmentId
    ? projects?.find((p) => p.id === departmentId)?.urlKey ?? null
    : null;

  // The folder path the upload should actually land at:
  //   - explicit folderPath wins (sub-folder selected)
  //   - otherwise, dept root → use the dept slug
  //   - otherwise, top-level (Company / identity layer) → empty string
  const effectiveFolderPath = folderPath || deptSlug || "";

  // Don't fire while we're still resolving the slug for dept-root uploads —
  // otherwise a fast-clicking user can race the projects query and re-create
  // the original "asset stored at empty path, vanishes from view" bug.
  const awaitingDeptSlug =
    Boolean(departmentId) && !folderPath && deptSlug === null;

  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      memoryAssetsApi.upload(companyId, file, {
        departmentId: departmentId ?? undefined,
        folderPath: effectiveFolderPath || undefined,
      }),
    onSuccess: (res) => {
      // Phase 6.2e dropped auto-extraction — uploads create a memory asset
      // and stop there. Earlier wording ("extraction queued") was stale and
      // implied a background job that no longer exists.
      pushToast({
        title: `Uploaded ${res.asset.fileName}`,
        tone: "success",
      });
      void qc.invalidateQueries({
        queryKey: queryKeys.memory.assets.list(companyId, {
          departmentId: departmentId ?? undefined,
          folderPath: effectiveFolderPath,
        }),
      });
      void qc.invalidateQueries({
        queryKey: queryKeys.memory.assets.list(companyId),
      });
    },
    onError: (err) =>
      pushToast({
        title: err instanceof Error ? err.message : "Upload failed",
        tone: "error",
      }),
  });

  function handlePick() {
    fileInputRef.current?.click();
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) {
      uploadMutation.mutate(f);
      e.target.value = "";
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={handlePick}
        disabled={uploadMutation.isPending || awaitingDeptSlug}
        title="Upload"
        aria-label="Upload"
        className={iconOnly ? "h-7 w-7 p-0" : "h-7 gap-1 text-xs"}
      >
        {uploadMutation.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Upload className="h-3 w-3" />
        )}
        {!iconOnly && "Upload"}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        hidden
        onChange={handleChange}
        accept=".pdf,.docx,.txt,.png,.jpg,.jpeg,.gif,.webp,.mp4,.webm,.mov,.pptx"
      />
    </>
  );
}
