import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { ArrowUp, FileText, Folder, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { filesystemApi, type FsBrowseEntry } from "../../api/filesystem";
import { useCompany } from "../../context/CompanyContext";

interface MemoryLocalFileListProps {
  localPath: string;
}

function baseName(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? value;
}

function entryKindLabel(entry: FsBrowseEntry): string {
  if (entry.isDirectory) return entry.isGitRepo ? "Git repository" : "Folder";
  return "File";
}

export function MemoryLocalFileList({ localPath }: MemoryLocalFileListProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix = selectedCompany?.issuePrefix ?? "";

  const browseQuery = useQuery({
    queryKey: ["filesystem", "memory-local", localPath],
    queryFn: () => filesystemApi.browse(localPath, {
      gitAware: true,
      includeFiles: true,
    }),
    enabled: Boolean(localPath),
  });

  function openLocalPath(nextPath: string) {
    const params = new URLSearchParams();
    params.set("localPath", nextPath);
    navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
  }

  if (browseQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
        Loading local files
      </div>
    );
  }

  if (browseQuery.isError || !browseQuery.data) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Could not read this local folder.
      </div>
    );
  }

  const result = browseQuery.data;

  return (
    <div className="h-full flex flex-col bg-card/30" data-testid="memory-local-list">
      <div
        className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-card px-3"
        data-testid="memory-list-header"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{baseName(result.currentPath)}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            Local folder - {result.entries.length} {result.entries.length === 1 ? "entry" : "entries"}
          </div>
        </div>
        {result.parentPath && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            aria-label="Open parent local folder"
            title="Parent folder"
            onClick={() => openLocalPath(result.parentPath!)}
          >
            <ArrowUp className="size-3.5" aria-hidden />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {result.entries.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">This local folder is empty.</div>
        ) : (
          result.entries.map((entry) => {
            const Icon = entry.isDirectory ? Folder : FileText;
            return (
              <button
                key={entry.path}
                type="button"
                disabled={!entry.isDirectory}
                className="flex w-full items-center gap-3 border-b border-border/60 px-4 py-2.5 text-left text-xs transition-colors enabled:hover:bg-muted/40 disabled:cursor-default"
                onClick={() => {
                  if (entry.isDirectory) openLocalPath(entry.path);
                }}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-muted-foreground">
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{entry.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {entryKindLabel(entry)}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
