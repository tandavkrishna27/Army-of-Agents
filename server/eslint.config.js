import tseslint from "typescript-eslint";

/**
 * Type-aware lint gate for @armyofagents/server (Phase 3, Task 8 / B4).
 *
 * Purpose: `assertCompanyAccess` is now async. A single dropped `await` on it
 * silently returns a truthy Promise and BYPASSES the 403 — a cross-tenant IDOR
 * that `tsc` cannot catch (a discarded `Promise<void>` is a valid statement).
 * `@typescript-eslint/no-floating-promises` flags exactly that class of bug, so
 * it runs as a REQUIRED, platform-independent CI gate.
 *
 * Scoped to production `src` code. `src/__tests__` is excluded from
 * server/tsconfig.json, so type-aware parsing cannot include it; it is ignored
 * here to avoid "file not found in project" parser errors.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "src/__tests__/**"],
  },
  {
    files: ["src/**/*.ts"],
    // This is a single-purpose gate. Existing `eslint-disable` comments in the
    // tree target rules a fuller config would run (no-explicit-any, no-console,
    // …) which are NOT enabled here; reporting them as "unused directives" would
    // be pure noise, so that check is disabled.
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
