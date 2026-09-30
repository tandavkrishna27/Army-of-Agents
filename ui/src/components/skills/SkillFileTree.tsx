import { FileCode2, FileText, Folder, FolderOpen } from "lucide-react";
import type { CompanySkillFileInventoryEntry } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

interface Props {
  inventory: CompanySkillFileInventoryEntry[];
  selectedPath: string;
  expandedDirs: Set<string>;
  onToggleDir: (dirPath: string) => void;
  onSelect: (filePath: string) => void;
}

interface TreeNode {
  name: string;
  path: string | null;
  kind: "dir" | "file";
  fileKind?: CompanySkillFileInventoryEntry["kind"];
  children: TreeNode[];
}

function buildTree(entries: CompanySkillFileInventoryEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: null, kind: "dir", children: [] };
  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let cursor = root;
    let prefix = "";
    for (const [i, segment] of segments.entries()) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const isLeaf = i === segments.length - 1;
      let next = cursor.children.find((c) => c.name === segment);
      if (!next) {
        next = {
          name: segment,
          path: isLeaf ? entry.path : prefix,
          kind: isLeaf ? "file" : "dir",
          fileKind: isLeaf ? entry.kind : undefined,
          children: [],
        };
        cursor.children.push(next);
      }
      cursor = next;
    }
  }
  function sortNode(node: TreeNode) {
    node.children.sort((a, b) => {
      // SKILL.md always first
      if (a.name === "SKILL.md") return -1;
      if (b.name === "SKILL.md") return 1;
      // Dirs before files
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNode);
  }
  sortNode(root);
  return root.children;
}

function fileIcon(kind: CompanySkillFileInventoryEntry["kind"] | undefined) {
  return kind === "script" || kind === "reference" ? FileCode2 : FileText;
}

interface RowsProps
  extends Pick<Props, "selectedPath" | "expandedDirs" | "onToggleDir" | "onSelect"> {
  nodes: TreeNode[];
  depth: number;
}

function Rows({ nodes, depth, selectedPath, expandedDirs, onToggleDir, onSelect }: RowsProps) {
  return (
    <>
      {nodes.map((node) => {
        const expanded = node.kind === "dir" && node.path ? expandedDirs.has(node.path) : false;
        const indent = 24 + depth * 16;
        if (node.kind === "dir") {
          return (
            <div key={node.path ?? node.name}>
              <button
                type="button"
                onClick={() => node.path && onToggleDir(node.path)}
                style={{ paddingLeft: `${indent}px` }}
                className="flex w-full items-center gap-2 py-1.5 pr-4 text-[12px] text-text/85 hover:bg-white/[0.04] hover:text-text"
              >
                {expanded ? (
                  <FolderOpen className="size-3.5" />
                ) : (
                  <Folder className="size-3.5" />
                )}
                <span className="flex-1 truncate text-left">{node.name}</span>
              </button>
              {expanded && (
                <Rows
                  nodes={node.children}
                  depth={depth + 1}
                  selectedPath={selectedPath}
                  expandedDirs={expandedDirs}
                  onToggleDir={onToggleDir}
                  onSelect={onSelect}
                />
              )}
            </div>
          );
        }
        const FileIcon = fileIcon(node.fileKind);
        const active = node.path === selectedPath;
        return (
          <button
            type="button"
            key={node.path ?? node.name}
            onClick={() => node.path && onSelect(node.path)}
            style={{ paddingLeft: `${indent}px` }}
            className={cn(
              "relative flex w-full items-center gap-2 py-1.5 pr-4 text-[12px] text-text/85 hover:bg-white/[0.04] hover:text-text",
              active && "bg-brand/10 text-brand",
            )}
          >
            <FileIcon className="size-3.5" />
            <span className="flex-1 truncate text-left">{node.name}</span>
            {active && (
              <span
                aria-hidden
                className="absolute right-3.5 top-1/2 size-[5px] -translate-y-1/2 rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
              />
            )}
          </button>
        );
      })}
    </>
  );
}

export function SkillFileTree({
  inventory,
  selectedPath,
  expandedDirs,
  onToggleDir,
  onSelect,
}: Props) {
  const tree = buildTree(inventory);
  return (
    <div className="border-b border-border bg-white/[0.015] py-2">
      <Rows
        nodes={tree}
        depth={0}
        selectedPath={selectedPath}
        expandedDirs={expandedDirs}
        onToggleDir={onToggleDir}
        onSelect={onSelect}
      />
    </div>
  );
}
