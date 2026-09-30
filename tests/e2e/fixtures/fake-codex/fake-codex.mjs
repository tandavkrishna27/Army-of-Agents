#!/usr/bin/env node
// Deterministic fake `codex` CLI for the Commander codex e2e
// (tests/e2e/commander-codex-*.spec.ts).
//
// Commander's cli-mode (server/src/services/internal-agent/cli-mode.ts)
// resolves the literal binary name "codex" from PATH and spawns
// `codex exec --json … -` — one process per chat turn (the process exits
// after the turn; the prompt is delivered over stdin via the `-` sentinel).
// BEFORE spawning, cli-mode writes a per-session CODEX_HOME/config.toml and
// best-effort copies ~/.codex/auth.json into it; this shim ignores all of
// that (it needs no auth and never reads config.toml). The playwright config
// prepends this fixture directory to the webServer's PATH so the spawn
// resolves to the `codex` / `codex.cmd` shims next to this file.
//
// Behavior: read a scripted turn from the control file (path from
// AOA_E2E_FAKE_CODEX_CONTROL, falling back to the deterministic tmpdir path
// the spec helper uses), emit it as newline-delimited codex JSONL that
// parseCodexJsonl (packages/adapters/codex-local/src/server/parse.ts) accepts,
// then exit. All argv is ignored EXCEPT `resume <id>` (the thread_id is reused
// so the resume turn renders continuity). The control file is rewritten by the
// spec before each send.
//
// Event shapes (mirror parseCodexJsonl exactly — verified against real
// `codex exec --json` output):
//   thread.started   {"type":"thread.started","thread_id"}            → sessionId
//   turn.started     {"type":"turn.started"}                          → ignored
//   reasoning        {"type":"item.completed","item":{"id","type":"reasoning","text"}}
//   agent_message    {"type":"item.completed","item":{"id","type":"agent_message","text"}}
//   turn.completed   {"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","output_tokens"}}
//   turn.failed      {"type":"turn.failed","error":{"message"}}       → errorMessage (on fail)
//
// Control file shape (single turn — one process == one turn):
//   {
//     "sessionId": "fake-codex-thread-1",   // optional; echoed as thread_id
//     "reasoning": "Planning the launch…",  // optional; omit → no reasoning item
//     "text": "the assistant reply (markdown)",
//     "usage": { "input": 120, "cached": 0, "output": 60 },  // optional
//     "fail": "model-400" | "generic"        // optional; omit → success
//   }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONTROL_PATH =
  process.env.AOA_E2E_FAKE_CODEX_CONTROL ||
  path.join(os.tmpdir(), "aoa-e2e-fake-codex-control.json");

// Invocation record (plan-review fix #2/#3): every spawn appends a JSON line
// describing HOW Commander actually invoked codex, so specs can PROVE the real
// cli-mode contract (exec --json … -, the model/effort flags, prompt-over-stdin,
// the per-session CODEX_HOME + its config.toml) rather than trusting the shim's
// own defaulting. Without this, e.g. the resume spec would pass even if
// Commander never sent `resume <id>`.
const INVOCATIONS_PATH =
  process.env.AOA_E2E_FAKE_CODEX_INVOCATIONS ||
  path.join(os.tmpdir(), "aoa-e2e-fake-codex-invocations.jsonl");

// If the parent closes our stdout mid-turn (Stop button / server shutdown),
// exit quietly instead of crashing with an unhandled EPIPE 'error' event.
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
  process.stderr.write(`fake-codex stdout error: ${err?.stack ?? err}\n`);
  process.exit(1);
});

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Drain stdin (the prompt delivered via `-`) so the parent's writable end
// closes cleanly; the content is captured for the invocation record but the
// scripted turn is driven by the control file, not the prompt.
let stdinContent = "";
try {
  stdinContent = fs.readFileSync(0, "utf8");
} catch {
  /* no stdin attached — fine */
}

const argv = process.argv.slice(2);

// Record the invocation (plan-review fix #2/#3) so specs can assert the real
// cli-mode contract. Best-effort, never fatal.
try {
  const codexHome = process.env.CODEX_HOME ?? null;
  let configTomlExists = false;
  if (codexHome) {
    try {
      configTomlExists = fs.statSync(path.join(codexHome, "config.toml")).isFile();
    } catch {
      configTomlExists = false;
    }
  }
  fs.appendFileSync(
    INVOCATIONS_PATH,
    JSON.stringify({ argv, stdin: stdinContent, codexHome, configTomlExists }) + "\n",
    "utf8",
  );
} catch {
  /* recording is best-effort */
}

function readControl() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTROL_PATH, "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // missing/corrupt control file — inert default so an unexpected spawn
    // never crashes the parent turn.
  }
  return { text: "fake-codex: no control file found." };
}

const control = readControl();

const resumeIdx = argv.indexOf("resume");
const resumeId = resumeIdx >= 0 ? argv[resumeIdx + 1] : null;
const threadId = resumeId || control.sessionId || "fake-codex-thread-1";

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

if (control.fail) {
  const message =
    control.fail === "model-400"
      ? "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."
      : "fake-codex: forced generic failure";
  emit({ type: "turn.failed", error: { message } });
  process.exit(1);
}

if (typeof control.reasoning === "string" && control.reasoning.length > 0) {
  emit({
    type: "item.completed",
    item: { id: "item_0", type: "reasoning", text: control.reasoning },
  });
}

if (Array.isArray(control.toolCalls)) {
  control.toolCalls.forEach((toolCall, idx) => {
    if (!toolCall || typeof toolCall.name !== "string" || toolCall.name.length === 0) return;
    const callId = `call_${idx + 1}`;
    const input = toolCall.input && typeof toolCall.input === "object" ? toolCall.input : {};
    const envelope = toolCall.envelope && typeof toolCall.envelope === "object"
      ? toolCall.envelope
      : { success: true, data: {}, summary: "" };

    emit({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: {
        type: "function_call",
        name: toolCall.name,
        namespace: "mcp__aoa__",
        arguments: JSON.stringify(input),
        call_id: callId,
      },
    });

    emit({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        call_id: callId,
        invocation: {
          server: "aoa",
          tool: toolCall.name,
          arguments: input,
        },
        result: {
          Ok: {
            content: [
              {
                type: "text",
                text: JSON.stringify(envelope),
              },
            ],
            isError: envelope.success === false,
          },
        },
      },
    });
  });
}

emit({
  type: "item.completed",
  item: {
    id: "item_1",
    type: "agent_message",
    text: typeof control.text === "string" ? control.text : "",
  },
});

emit({
  type: "turn.completed",
  usage: {
    input_tokens: control.usage?.input ?? 100,
    cached_input_tokens: control.usage?.cached ?? 0,
    output_tokens: control.usage?.output ?? 50,
  },
});

process.exit(0);
