import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@armyofagents/db";
import type { DeploymentMode } from "@armyofagents/shared";
import { assertCompanyAccess } from "./authz.js";
import { resolveCompanyWorkspaceRoot } from "../services/company-workspace-root.js";
import {
  containBrowsePath,
  containMkdirPath,
  verifyCreatedDirStillContained,
} from "../services/fs-jail.js";
import { SKIP_DIRS, checkGitRepo, isAbsolutePath } from "./filesystem.js";

/**
 * WS0a — company-scoped filesystem capability. Deployment-split behind
 * resolveCompanyWorkspaceRoot():
 *   - local_trusted: unjailed, real filesystem, scoped to the founder's
 *     home area (same behavior as the legacy instance-admin
 *     /filesystem/* routes in routes/filesystem.ts, which is left
 *     UNCHANGED — this is a parallel, membership-authorized surface, not a
 *     replacement).
 *   - authenticated: jailed to a server-owned per-company base dir. Every
 *     browse/mkdir target is contained via services/fs-jail.ts.
 *
 * Authorized by company MEMBERSHIP (assertCompanyAccess), not instance-admin
 * — this is what lets a non-admin founder/team member use the Engine +
 * Department onboarding steps without needing instance-admin rights.
 */
export function companyWorkspaceFsRoutes(opts: {
  db: Db;
  deploymentMode: DeploymentMode;
  companyWorkspaceBaseDir: string;
}) {
  const router = Router();
  const db = opts.db;

  function resolveRoot(companyId: string) {
    return resolveCompanyWorkspaceRoot(companyId, opts.deploymentMode, {
      companyWorkspaceBaseDir: opts.companyWorkspaceBaseDir,
    });
  }

  // Get the workspace home dir (jail root when jailed; real home otherwise).
  router.get("/companies/:cid/workspace-fs/home", async (req, res) => {
    const companyId = req.params.cid as string;
    await assertCompanyAccess(db, req, companyId);
    const root = resolveRoot(companyId);

    if (root.jailed) {
      try {
        await fs.mkdir(root.baseDir, { recursive: true });
      } catch (err) {
        res.status(500).json({
          error: "Failed to provision company workspace root",
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }

    res.json({ homePath: root.baseDir, platform: process.platform, jailed: root.jailed });
  });

  // List available drives — empty/hidden when jailed.
  router.get("/companies/:cid/workspace-fs/drives", async (req, res) => {
    const companyId = req.params.cid as string;
    await assertCompanyAccess(db, req, companyId);
    const root = resolveRoot(companyId);

    if (root.jailed) {
      res.json({ drives: [], platform: process.platform, jailed: true });
      return;
    }

    if (process.platform === "win32") {
      const drives: Array<{ name: string; path: string }> = [];
      const checks = [];
      for (let code = 65; code <= 90; code++) {
        const letter = String.fromCharCode(code);
        const drivePath = `${letter}:\\`;
        checks.push(
          fs
            .stat(drivePath)
            .then(() => drives.push({ name: `${letter}:`, path: drivePath }))
            .catch(() => {}),
        );
      }
      await Promise.all(checks);
      drives.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ drives, platform: "win32", jailed: false });
    } else {
      res.json({
        drives: [{ name: "/", path: "/" }],
        platform: process.platform,
        jailed: false,
      });
    }
  });

  // Browse directory contents, confined to the resolved workspace root when jailed.
  router.get("/companies/:cid/workspace-fs/browse", async (req, res) => {
    const companyId = req.params.cid as string;
    await assertCompanyAccess(db, req, companyId);
    const root = resolveRoot(companyId);

    const rawPath = (req.query.path as string) || root.baseDir;
    const gitAware = req.query.gitAware === "true";
    const includeFiles = req.query.includeFiles === "true";
    const extensions = (req.query.extensions as string)?.split(",").filter(Boolean) ?? [];

    if (!isAbsolutePath(rawPath)) {
      res.status(400).json({ error: "Path must be absolute" });
      return;
    }

    let resolvedPath: string;

    if (root.jailed) {
      try {
        await fs.mkdir(root.baseDir, { recursive: true });
      } catch (err) {
        res.status(500).json({
          error: "Failed to provision company workspace root",
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const containment = await containBrowsePath(root.baseDir, rawPath);
      if (!containment.ok) {
        if (containment.reason === "not_found") {
          res.status(404).json({ error: "Directory not found" });
        } else {
          res.status(403).json({ error: "Path is outside the company workspace boundary" });
        }
        return;
      }
      resolvedPath = containment.resolvedPath;
    } else {
      resolvedPath = path.resolve(rawPath);
    }

    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: "Path is not a directory" });
        return;
      }
    } catch {
      res.status(404).json({ error: "Directory not found" });
      return;
    }

    try {
      const dirents = await fs.readdir(resolvedPath, { withFileTypes: true });
      const entries: Array<{
        name: string;
        path: string;
        isDirectory: boolean;
        isGitRepo: boolean;
      }> = [];

      for (const dirent of dirents) {
        if (dirent.name.startsWith(".")) continue;
        if (SKIP_DIRS.has(dirent.name)) continue;

        const entryPath = path.join(resolvedPath, dirent.name);
        const isDir = dirent.isDirectory();

        if (!isDir && !includeFiles) continue;
        if (!isDir && includeFiles && extensions.length > 0) {
          const ext = path.extname(dirent.name).toLowerCase();
          if (!extensions.includes(ext)) continue;
        }

        entries.push({ name: dirent.name, path: entryPath, isDirectory: isDir, isGitRepo: false });
      }

      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });

      if (gitAware) {
        const dirEntries = entries.filter((e) => e.isDirectory);
        const checks = dirEntries.slice(0, 50).map(async (entry) => {
          entry.isGitRepo = await checkGitRepo(entry.path);
        });
        await Promise.all(checks);
      }

      let parentPath: string | null;
      if (root.jailed) {
        // Never let "go up" escape the jail root.
        parentPath = resolvedPath === root.baseDir ? null : path.dirname(resolvedPath);
      } else {
        const parsed = path.parse(resolvedPath);
        parentPath = parsed.root === resolvedPath ? null : path.dirname(resolvedPath);
      }

      res.json({
        currentPath: resolvedPath,
        parentPath,
        homePath: root.baseDir,
        platform: process.platform,
        jailed: root.jailed,
        entries,
      });
    } catch (err) {
      res.status(500).json({
        error: "Failed to read directory",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Create a directory, confined to the resolved workspace root when jailed.
  router.post("/companies/:cid/workspace-fs/mkdir", async (req, res) => {
    const companyId = req.params.cid as string;
    await assertCompanyAccess(db, req, companyId);
    const root = resolveRoot(companyId);
    const { path: dirPath } = req.body as { path?: string };

    if (!dirPath || !isAbsolutePath(dirPath)) {
      res.status(400).json({ error: "Absolute path is required" });
      return;
    }

    if (!root.jailed) {
      const resolvedPath = path.resolve(dirPath);
      try {
        await fs.mkdir(resolvedPath, { recursive: true });
        res.json({ created: true, path: resolvedPath });
      } catch (err) {
        res.status(500).json({
          error: "Failed to create directory",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    try {
      await fs.mkdir(root.baseDir, { recursive: true });
    } catch (err) {
      res.status(500).json({
        error: "Failed to provision company workspace root",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const containment = await containMkdirPath(root.baseDir, dirPath);
    if (!containment.ok) {
      if (containment.reason === "not_found") {
        res.status(404).json({ error: "Parent directory not found" });
      } else {
        res.status(403).json({ error: "Path is outside the company workspace boundary" });
      }
      return;
    }

    try {
      await fs.mkdir(containment.resolvedPath, { recursive: true });
    } catch (err) {
      res.status(500).json({
        error: "Failed to create directory",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Best-effort symlink-replace-race guard: re-verify containment on the
    // just-created directory's realpath. If something swapped a symlink in
    // between the pre-check and the mkdir syscall, roll back and reject.
    const stillContained = await verifyCreatedDirStillContained(
      root.baseDir,
      containment.resolvedPath,
    );
    if (!stillContained) {
      await fs.rm(containment.resolvedPath, { recursive: true, force: true }).catch(() => {});
      res.status(403).json({ error: "Path is outside the company workspace boundary" });
      return;
    }

    res.json({ created: true, path: containment.resolvedPath });
  });

  return router;
}
