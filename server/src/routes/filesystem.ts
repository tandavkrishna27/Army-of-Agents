import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { z } from "zod";
import { assertCanManageInstanceSettings } from "./authz.js";
import { assertLocalWorkspaceCommandAllowed } from "../services/local-workspace-command-guard.js";

// Exported for reuse by the WS0a company-scoped workspace-fs routes
// (routes/company-workspace-fs.ts) — purely additive; the handlers below are
// unchanged.
export const SKIP_DIRS = new Set([
  "node_modules",
  "__pycache__",
  ".venv",
  "$Recycle.Bin",
  "System Volume Information",
  ".Trash",
  ".Trash-1000",
]);

export function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

// Robust boundary check: returns true iff `candidate` is `parent` itself or a
// descendant of it. Uses path.relative() to defeat the prefix-bypass anti-
// pattern (e.g. `target.startsWith("/Users/alice")` accepts `/Users/alice2/x`).
function isPathInsideDir(parent: string, candidate: string): boolean {
  if (candidate === parent) return true;
  const rel = path.relative(parent, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function checkGitRepo(dirPath: string): Promise<boolean> {
  try {
    assertLocalWorkspaceCommandAllowed("filesystem Git repository probe");
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--git-dir"], { cwd: dirPath, timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
}

export function filesystemRoutes() {
  const router = Router();

  // Browse directory contents
  router.get("/filesystem/browse", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const rawPath = (req.query.path as string) || os.homedir();
    const gitAware = req.query.gitAware === "true";
    const includeFiles = req.query.includeFiles === "true";
    const extensions = (req.query.extensions as string)?.split(",").filter(Boolean) ?? [];

    if (!isAbsolutePath(rawPath)) {
      res.status(400).json({ error: "Path must be absolute" });
      return;
    }

    const resolvedPath = path.resolve(rawPath);

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
        // Skip hidden dirs (starting with .) unless it's a special case
        if (dirent.name.startsWith(".")) continue;
        // Skip system/build dirs
        if (SKIP_DIRS.has(dirent.name)) continue;

        const entryPath = path.join(resolvedPath, dirent.name);
        const isDir = dirent.isDirectory();

        if (!isDir && !includeFiles) continue;
        if (!isDir && includeFiles && extensions.length > 0) {
          const ext = path.extname(dirent.name).toLowerCase();
          if (!extensions.includes(ext)) continue;
        }

        entries.push({
          name: dirent.name,
          path: entryPath,
          isDirectory: isDir,
          isGitRepo: false,
        });
      }

      // Sort: directories first, then alphabetical
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });

      // Git detection (only for directories, when gitAware is requested)
      if (gitAware) {
        const dirEntries = entries.filter((e) => e.isDirectory);
        // Batch check — limit to first 50 to avoid slowness
        const checks = dirEntries.slice(0, 50).map(async (entry) => {
          entry.isGitRepo = await checkGitRepo(entry.path);
        });
        await Promise.all(checks);
      }

      const parsed = path.parse(resolvedPath);
      const parentPath = parsed.root === resolvedPath ? null : path.dirname(resolvedPath);

      res.json({
        currentPath: resolvedPath,
        parentPath,
        homePath: os.homedir(),
        platform: process.platform,
        entries,
      });
    } catch (err) {
      res.status(500).json({
        error: "Failed to read directory",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Create directory
  router.post("/filesystem/mkdir", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const { path: dirPath } = req.body as { path?: string };

    if (!dirPath || !isAbsolutePath(dirPath)) {
      res.status(400).json({ error: "Absolute path is required" });
      return;
    }

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
  });

  // Get home directory (useful for client-side path suggestions)
  router.get("/filesystem/home", (req, res) => {
    assertCanManageInstanceSettings(req);
    res.json({ homePath: os.homedir(), platform: process.platform });
  });

  // Open a path in the OS file manager (Finder / Explorer / xdg-open)
  const revealBodySchema = z.object({ path: z.string().min(1) });

  router.post("/filesystem/reveal", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const parsed = revealBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    const target = path.resolve(parsed.data.path);

    const homeDir = os.homedir();
    if (!isPathInsideDir(homeDir, target)) {
      res.status(400).json({ error: "Path outside home directory" });
      return;
    }

    try {
      await fs.access(target);
    } catch {
      res.status(404).json({ error: "Path does not exist" });
      return;
    }

    const cmd =
      os.platform() === "darwin"
        ? "open"
        : os.platform() === "win32"
          ? "explorer"
          : "xdg-open";
    const child = spawn(cmd, [target], { detached: true, stdio: "ignore" });
    child.unref();
    res.json({ ok: true });
  });

  // List available drives (Windows) or filesystem roots (macOS/Linux)
  router.get("/filesystem/drives", async (req, res) => {
    assertCanManageInstanceSettings(req);
    if (process.platform === "win32") {
      // Check drive letters A-Z by trying to stat them
      const drives: Array<{ name: string; path: string }> = [];
      const checks = [];
      for (let code = 65; code <= 90; code++) {
        const letter = String.fromCharCode(code);
        const drivePath = `${letter}:\\`;
        checks.push(
          fs.stat(drivePath)
            .then(() => drives.push({ name: `${letter}:`, path: drivePath }))
            .catch(() => {}),
        );
      }
      await Promise.all(checks);
      // Sort by drive letter
      drives.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ drives, platform: "win32" });
    } else {
      // macOS/Linux — single root
      res.json({
        drives: [{ name: "/", path: "/" }],
        platform: process.platform,
      });
    }
  });

  return router;
}
