import path from "node:path";
import { resolveAoaInstanceRoot, resolveHomeAwarePath } from "../home-paths.js";

function isStrictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Recursive workspace cleanup is limited to server-owned allocation roots.
 * Persisted row metadata is deliberately not trusted: older public PATCH
 * contracts allowed callers to forge it.
 */
export function isApprovedRuntimeWorkspacePath(input: {
  candidate: string;
  projectWorkspaceCwds?: Array<string | null | undefined>;
}): boolean {
  const roots = [
    ...((input.projectWorkspaceCwds ?? [])
      .filter((cwd): cwd is string => Boolean(cwd?.trim()))
      .map((cwd) => path.resolve(cwd, ".aoa", "worktrees"))),
    path.resolve(resolveAoaInstanceRoot(), "workspaces"),
  ];
  const configuredRoot = process.env.AOA_WORKTREES_DIR?.trim();
  if (configuredRoot) roots.push(resolveHomeAwarePath(configuredRoot));
  return roots.some((root) => isStrictDescendant(root, input.candidate));
}
