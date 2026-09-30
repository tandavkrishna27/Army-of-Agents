import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";

export interface WorkspaceEntrySnapshot {
  kind: "file" | "directory" | "symlink";
  sha256?: string;
  mode?: number;
  linkTarget?: string;
}

export type WorkspaceSnapshot = Map<string, WorkspaceEntrySnapshot>;

export interface CaptureWorkspaceSnapshotOptions {
  ignoreDirs?: string[];
}

export interface MergeChangedWorkspaceFilesOptions {
  before: WorkspaceSnapshot;
  afterRoot: string;
  destinationRoot: string;
}

const DEFAULT_IGNORE_DIRS = [".git", "node_modules"];

export async function captureWorkspaceSnapshot(
  root: string,
  options: CaptureWorkspaceSnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();
  const ignoreDirs = new Set(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
  const rootPath = path.resolve(root);

  await captureDirectory(rootPath, "", snapshot, ignoreDirs);

  return snapshot;
}

export async function mergeChangedWorkspaceFiles({
  before,
  afterRoot,
  destinationRoot,
}: MergeChangedWorkspaceFilesOptions): Promise<void> {
  const after = await captureWorkspaceSnapshot(afterRoot);
  const afterRootPath = path.resolve(afterRoot);
  const destinationRootPath = path.resolve(destinationRoot);
  const ignoreNames = new Set(DEFAULT_IGNORE_DIRS);
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  const deletedPaths: string[] = [];
  const copiedPaths: string[] = [];

  for (const rawRelativePath of allPaths) {
    const relativePath = normalizeSnapshotKey(rawRelativePath);
    if (isIgnoredSnapshotPath(relativePath, ignoreNames)) {
      continue;
    }

    const beforeEntry = before.get(rawRelativePath) ?? before.get(relativePath);
    const afterEntry = after.get(rawRelativePath) ?? after.get(relativePath);

    if (entriesEqual(beforeEntry, afterEntry)) {
      continue;
    }

    if (!afterEntry) {
      deletedPaths.push(relativePath);
    } else {
      copiedPaths.push(relativePath);
    }
  }

  deletedPaths.sort(sortDeepestFirst);
  for (const relativePath of deletedPaths) {
    await rm(resolveInsideRoot(destinationRootPath, relativePath), { force: true, recursive: true });
  }

  copiedPaths.sort(sortShallowestFirst);
  for (const relativePath of copiedPaths) {
    const afterEntry = after.get(relativePath);
    if (!afterEntry) {
      continue;
    }

    const sourcePath = resolveInsideRoot(afterRootPath, relativePath);
    const destinationPath = resolveInsideRoot(destinationRootPath, relativePath);
    await copyEntry(sourcePath, destinationPath, afterEntry, destinationRootPath);
  }
}

async function captureDirectory(
  root: string,
  relativeDirectory: string,
  snapshot: WorkspaceSnapshot,
  ignoreDirs: Set<string>,
) {
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });

  for (const entry of entries) {
    if (ignoreDirs.has(entry.name)) {
      continue;
    }

    const relativePath = toPosixPath(path.join(relativeDirectory, entry.name));
    const absolutePath = path.join(root, relativePath);
    const stat = await lstat(absolutePath);

    if (stat.isSymbolicLink()) {
      snapshot.set(relativePath, {
        kind: "symlink",
        linkTarget: await readlink(absolutePath),
        mode: stat.mode,
      });
      continue;
    }

    if (stat.isDirectory()) {
      snapshot.set(relativePath, { kind: "directory", mode: stat.mode });
      await captureDirectory(root, relativePath, snapshot, ignoreDirs);
      continue;
    }

    if (stat.isFile()) {
      snapshot.set(relativePath, {
        kind: "file",
        mode: stat.mode,
        sha256: createHash("sha256").update(await readFile(absolutePath)).digest("hex"),
      });
    }
  }
}

async function copyEntry(
  sourcePath: string,
  destinationPath: string,
  entry: WorkspaceEntrySnapshot,
  destinationRoot: string,
) {
  await mkdir(path.dirname(destinationPath), { recursive: true });

  if (entry.kind === "directory") {
    await removeIfNotDirectory(destinationPath);
    await mkdir(destinationPath, { recursive: true });
    await applyMode(destinationPath, entry);
    return;
  }

  if (entry.kind === "symlink") {
    if (!entry.linkTarget) {
      throw new Error(`Cannot restore symlink without link target: ${destinationPath}`);
    }
    validateSymlinkTargetInsideRoot(destinationRoot, destinationPath, entry.linkTarget);
    await rm(destinationPath, { force: true, recursive: true });
    await symlink(entry.linkTarget, destinationPath);
    return;
  }

  await rm(destinationPath, { force: true, recursive: true });
  await copyFile(sourcePath, destinationPath);
  await applyMode(destinationPath, entry);
}

async function removeIfNotDirectory(destinationPath: string) {
  try {
    const stat = await lstat(destinationPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await rm(destinationPath, { force: true, recursive: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function applyMode(filePath: string, entry: WorkspaceEntrySnapshot) {
  if (typeof entry.mode !== "number") {
    return;
  }

  await chmod(filePath, entry.mode);
}

function entriesEqual(
  left: WorkspaceEntrySnapshot | undefined,
  right: WorkspaceEntrySnapshot | undefined,
) {
  if (!left || !right) {
    return left === right;
  }

  return (
    left.kind === right.kind &&
    left.sha256 === right.sha256 &&
    left.mode === right.mode &&
    left.linkTarget === right.linkTarget
  );
}

function resolveInsideRoot(root: string, relativePath: string) {
  const safeRelativePath = normalizeSnapshotKey(relativePath);
  const resolved = path.resolve(root, safeRelativePath);
  const relative = path.relative(root, resolved);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Workspace snapshot path escapes root: ${relativePath}`);
  }

  return resolved;
}

function validateSymlinkTargetInsideRoot(destinationRoot: string, linkPath: string, linkTarget: string) {
  if (path.isAbsolute(linkTarget)) {
    throw new Error(`Workspace symlink target escapes root: ${linkTarget}`);
  }

  const linkDirectory = path.dirname(linkPath);
  const resolvedTarget = path.resolve(linkDirectory, linkTarget);
  const relative = path.relative(destinationRoot, resolvedTarget);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Workspace symlink target escapes root: ${linkTarget}`);
  }
}

function normalizeSnapshotKey(relativePath: string) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error(`Invalid workspace snapshot path: ${relativePath}`);
  }

  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));

  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Workspace snapshot path escapes root: ${relativePath}`);
  }

  return normalized;
}

function isIgnoredSnapshotPath(relativePath: string, ignoreNames: Set<string>) {
  return relativePath.split("/").some((part) => ignoreNames.has(part));
}

function sortDeepestFirst(left: string, right: string) {
  return depth(right) - depth(left) || right.localeCompare(left);
}

function sortShallowestFirst(left: string, right: string) {
  return depth(left) - depth(right) || left.localeCompare(right);
}

function depth(relativePath: string) {
  return relativePath.split("/").length;
}

function toPosixPath(relativePath: string) {
  return relativePath.split(path.sep).join("/");
}
