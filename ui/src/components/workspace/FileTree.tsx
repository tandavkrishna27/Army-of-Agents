import { useState, useMemo, useCallback } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ChevronDown, Search, FolderOpen, Folder } from "lucide-react";
import { fileIcon, formatBytes, sourceLabel } from "./workspace-utils";
import type { DetectedOutput } from "@armyofagents/shared";

/* ── Types ───────────────────────────────────────────────────────────────────── */

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  file: DetectedOutput | null; // null = directory
  fileCount: number;
}

interface FileTreeProps {
  outputs: DetectedOutput[];
  selectedFile?: string | null;
  onSelectFile?: (path: string) => void;
  workspaceId?: string;
}

/* ── Tree building ───────────────────────────────────────────────────────────── */

function buildTree(outputs: DetectedOutput[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [], file: null, fileCount: 0 };

  for (const output of outputs) {
    const parts = output.path.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const partPath = parts.slice(0, i + 1).join("/");

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: partPath,
          children: [],
          file: isFile ? output : null,
          fileCount: 0,
        };
        current.children.push(child);
      }
      if (isFile) {
        child.file = output;
      }
      current = child;
    }
  }

  // Count files per directory
  function countFiles(node: TreeNode): number {
    if (node.file) return 1;
    let count = 0;
    for (const child of node.children) {
      count += countFiles(child);
    }
    node.fileCount = count;
    return count;
  }
  countFiles(root);

  // Sort: directories first, then files, alphabetical within each
  function sortChildren(node: TreeNode) {
    node.children.sort((a, b) => {
      const aIsDir = a.file === null;
      const bIsDir = b.file === null;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of node.children) sortChildren(child);
  }
  sortChildren(root);

  return root;
}

/* ── Filter tree by search query ─────────────────────────────────────────────── */

function filterTree(node: TreeNode, query: string): TreeNode | null {
  const lowerQuery = query.toLowerCase();

  if (node.file) {
    return node.name.toLowerCase().includes(lowerQuery) ? node : null;
  }

  const filteredChildren: TreeNode[] = [];
  for (const child of node.children) {
    const filtered = filterTree(child, query);
    if (filtered) filteredChildren.push(filtered);
  }

  if (filteredChildren.length === 0 && !node.name.toLowerCase().includes(lowerQuery)) {
    return null;
  }

  return { ...node, children: filteredChildren };
}

/* ── Persistence ─────────────────────────────────────────────────────────────── */

function collapsedKey(workspaceId: string) {
  return `aoa:workspace:filetree-collapsed:${workspaceId}`;
}

function loadCollapsed(workspaceId: string): Set<string> {
  try {
    const stored = localStorage.getItem(collapsedKey(workspaceId));
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsed(workspaceId: string, collapsed: Set<string>) {
  try {
    localStorage.setItem(collapsedKey(workspaceId), JSON.stringify([...collapsed]));
  } catch {
    // ignore
  }
}

/* ── Components ──────────────────────────────────────────────────────────────── */

function TreeDirectory({
  node,
  depth,
  collapsed,
  onToggle,
  selectedFile,
  onSelectFile,
  forceExpand,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  selectedFile?: string | null;
  onSelectFile?: (path: string) => void;
  forceExpand: boolean;
}) {
  const isCollapsed = !forceExpand && collapsed.has(node.path);
  const FolderIcon = isCollapsed ? Folder : FolderOpen;

  return (
    <div data-testid={`filetree-dir-${node.path}`}>
      <button
        type="button"
        className="flex items-center gap-1 w-full px-2 py-1 text-left hover:bg-accent/50 transition-colors"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => onToggle(node.path)}
      >
        {isCollapsed ? (
          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <FolderIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-[11px] font-medium truncate">{node.name}</span>
        <span className="ml-auto text-[9px] text-muted-foreground shrink-0 bg-muted rounded-full px-1.5">
          {node.fileCount}
        </span>
      </button>

      {!isCollapsed && (
        <div>
          {node.children.map((child) =>
            child.file ? (
              <TreeFile
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedFile={selectedFile}
                onSelectFile={onSelectFile}
              />
            ) : (
              <TreeDirectory
                key={child.path}
                node={child}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
                selectedFile={selectedFile}
                onSelectFile={onSelectFile}
                forceExpand={forceExpand}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function TreeFile({
  node,
  depth,
  selectedFile,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  selectedFile?: string | null;
  onSelectFile?: (path: string) => void;
}) {
  const output = node.file!;
  const Icon = fileIcon(output.contentType);
  const badge = sourceLabel(output.source);
  const isSelected = selectedFile === output.path;

  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-1.5 w-full px-2 py-1 text-left hover:bg-accent/50 transition-colors",
        isSelected && "bg-accent/30",
      )}
      style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
      onClick={() => onSelectFile?.(output.path)}
      data-testid={`filetree-file-${output.path}`}
    >
      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-[11px] font-mono truncate flex-1">{node.name}</span>
      <span className={cn("text-[8px] px-1 py-0.5 rounded font-medium shrink-0", badge.className)}>
        {badge.text}
      </span>
      <span className="text-[9px] text-muted-foreground tabular-nums shrink-0">
        {formatBytes(output.byteSize)}
      </span>
    </button>
  );
}

/* ── Main component ──────────────────────────────────────────────────────────── */

export function FileTree({ outputs, selectedFile, onSelectFile, workspaceId }: FileTreeProps) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    workspaceId ? loadCollapsed(workspaceId) : new Set(),
  );

  const tree = useMemo(() => buildTree(outputs), [outputs]);

  const displayTree = useMemo(() => {
    if (!search.trim()) return tree;
    return filterTree(tree, search.trim());
  }, [tree, search]);

  const toggleDir = useCallback(
    (path: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        if (workspaceId) saveCollapsed(workspaceId, next);
        return next;
      });
    },
    [workspaceId],
  );

  if (outputs.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground" data-testid="filetree-empty">
        No changed files
      </div>
    );
  }

  const forceExpand = search.trim().length > 0;

  return (
    <div className="flex flex-col" data-testid="filetree">
      {/* Search */}
      <div className="px-2 py-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            type="text"
            placeholder="Filter files..."
            className="w-full rounded border border-input bg-background pl-7 pr-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="filetree-search"
          />
        </div>
      </div>

      {/* Tree */}
      <div className="overflow-y-auto max-h-[50vh]">
        {displayTree ? (
          displayTree.children.map((child) =>
            child.file ? (
              <TreeFile
                key={child.path}
                node={child}
                depth={0}
                selectedFile={selectedFile}
                onSelectFile={onSelectFile}
              />
            ) : (
              <TreeDirectory
                key={child.path}
                node={child}
                depth={0}
                collapsed={collapsed}
                onToggle={toggleDir}
                selectedFile={selectedFile}
                onSelectFile={onSelectFile}
                forceExpand={forceExpand}
              />
            ),
          )
        ) : (
          <div className="px-3 py-2 text-xs text-muted-foreground">No matches</div>
        )}
      </div>

      {/* Summary */}
      <div className="px-3 py-1 text-[10px] text-muted-foreground border-t border-border">
        {outputs.length} file{outputs.length !== 1 ? "s" : ""} changed
      </div>
    </div>
  );
}
