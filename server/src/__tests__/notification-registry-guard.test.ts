import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function walkTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.name === "dist" || entry.name === "node_modules") return [];
    if (entry.isDirectory()) return walkTsFiles(full);
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  });
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function hasGuardedNotificationInsert(source: string): boolean {
  const guardedNames = new Set(["notifications", "hubItems"]);
  const importPattern =
    /import\s*\{([\s\S]*?)\}\s*from\s*["']@armyofagents\/db["']/g;
  for (const match of source.matchAll(importPattern)) {
    const specifiers = match[1] ?? "";
    for (const specifier of specifiers.split(",")) {
      const trimmed = specifier.trim();
      const alias = /^notifications\s+as\s+(\w+)$/.exec(trimmed)
        ?? /^hubItems\s+as\s+(\w+)$/.exec(trimmed);
      if (alias?.[1]) guardedNames.add(alias[1]);
    }
  }
  const guardedAlternation = [...guardedNames].join("|");
  return new RegExp(`\\.insert\\s*\\(\\s*(${guardedAlternation})\\s*\\)`).test(source);
}

describe("notification registry guard", () => {
  it("detects aliased notification table inserts", () => {
    expect(hasGuardedNotificationInsert(`
      import { notifications as notificationRows } from "@armyofagents/db";
      await db.insert(notificationRows).values({});
    `)).toBe(true);
    expect(hasGuardedNotificationInsert(`
      import { hubItems as attentionRows } from "@armyofagents/db";
      await db.insert(attentionRows).values({});
    `)).toBe(true);
  });

  it("keeps production notification row inserts behind the hub service", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const allowed = new Set(["services/hub-items.ts"]);
    const offenders = walkTsFiles(root)
      .filter((file) => !file.includes("__tests__"))
      .map((file) => ({
        rel: relative(root, file).replace(/\\/g, "/"),
        source: stripComments(readFileSync(file, "utf8")),
      }))
      .filter(({ rel }) => !allowed.has(rel))
      .filter(({ source }) => hasGuardedNotificationInsert(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });
});
