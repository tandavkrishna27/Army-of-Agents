#!/usr/bin/env node
// Deterministic fake `claude` CLI for the Commander viewer e2e
// (tests/e2e/commander-viewer.spec.ts) AND for the keyless extraction e2e
// (tests/e2e/keyless-extraction.spec.ts).
//
// ── EXTRACTION MODE (keyless path, Task 16) ───────────────────────────────
// server/src/services/extraction-cli.ts invokes claude as:
//   claude --print --system-prompt-file <f> --output-format text
// and delivers the entry content over stdin. It expects PLAIN TEXT stdout
// (a JSON array of extracted items that parseExtractedItems can consume).
//
// Detection: if argv does NOT contain "--output-format stream-json" (i.e.
// this is NOT a Commander chat spawn), we are in extraction mode. The control
// file for extraction mode uses the `extractionText` field:
//   { "extractionText": "[{\"kind\":\"task\",\"title\":\"...\"}]" }
//   { "extractionText": "not json at all" }   ← forces unparseable failure
//   { "fail": "exit" }                         ← nonzero exit (forces failure)
//
// In extraction mode the shim writes the extractionText (or nothing on fail)
// to stdout and exits 0 (or 1 on { fail: "exit" }).
//
// ── COMMANDER / CHAT MODE (existing behavior) ─────────────────────────────
// Commander's cli-mode (server/src/services/internal-agent/cli-mode.ts)
// resolves the literal binary name "claude" from PATH (`which`/`where`) and
// spawns it with `--print --output-format stream-json …` — one process per
// chat turn (the process exits after the turn; the session-store entry is
// reaped by the exit handler, so the next message spawns a fresh process).
// The e2e playwright config prepends this fixture directory to the
// webServer's PATH so the spawn resolves to the `claude` / `claude.cmd`
// shims next to this file.
//
// Behavior: read a scripted turn from the control file (path from
// AOA_E2E_FAKE_CLAUDE_CONTROL, falling back to the deterministic tmpdir path
// the spec helper uses), emit it as newline-delimited stream-json that
// parse-stream-json.ts actually accepts, then exit 0. All argv is ignored —
// the script is fully controlled by the control file, which the spec
// rewrites before each send.
//
// Event shapes (mirrors parse-stream-json.ts exactly):
//   tool_use     {"type":"assistant","message":{"content":[{"type":"tool_use","id","name","input"}]}}
//   tool_result  {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id","content":"<envelope JSON string>","is_error"}]}}
//                — content mirrors mcp-bridge executeAndFormat: a stringified
//                  {success,data,summary,error?,outputRefs?} envelope. Refs are
//                  lifted ONLY when the tool name starts with "mcp__".
//   text         {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text"}}}
//                — assistant-event text blocks are SKIPPED by the parser
//                  (text streams via stream_event deltas), so the final
//                  assistant message below is realism-only.
//   done         {"type":"result","subtype":"success",...}
//
// Control file shape (single turn — one process == one turn):
//   {
//     "toolCalls": [
//       { "name": "mcp__aoa__create_artifact", "input": {...},
//         "envelope": { "success": true, "data": {...}, "summary": "...", "outputRefs": [...] },
//         "isError": false }
//     ],
//     "text": "final assistant reply (markdown)"
//   }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONTROL_PATH =
  process.env.AOA_E2E_FAKE_CLAUDE_CONTROL ||
  path.join(os.tmpdir(), "aoa-e2e-fake-claude-control.json");

// Invocation record: every spawn appends a JSON line describing HOW
// Commander actually invoked claude, so specs can PROVE the real cli-mode
// contract (argv flags, prompt-over-stdin, cwd) rather than trusting the
// shim's own defaulting. Mirrors the same pattern in fake-codex.mjs.
const INVOCATIONS_PATH =
  process.env.AOA_E2E_FAKE_CLAUDE_INVOCATIONS ||
  path.join(os.tmpdir(), "aoa-e2e-fake-claude-invocations.jsonl");

// If the parent closes our stdout mid-turn (Stop button kills the CLI
// session, or the server shuts down), exit quietly instead of crashing with
// an unhandled EPIPE 'error' event.
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
  process.stderr.write(`fake-claude stdout error: ${err?.stack ?? err}\n`);
  process.exit(1);
});

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Capture argv + stdin for the invocation record WITHOUT blocking. The real
// cli-mode spawns claude one-shot per turn but does NOT always close claude's
// stdin (today the prompt rides argv and the stdin pipe is left open), so a
// synchronous readFileSync(0) would DEADLOCK here: the parent waits for our
// stdout before it would ever close stdin, and we'd be waiting for stdin EOF.
// Accumulate stdin asynchronously instead and write the record just before exit.
const argv = process.argv.slice(2);
let stdinContent = "";
// Resolves when stdin reaches EOF (the parent closed the pipe). Extraction mode
// awaits this so the invocation record captures the piped prompt — the keyless
// extractor (extraction-cli.ts extractViaClaude) writes the content to stdin
// then closes it, and extraction mode otherwise exits before the async 'data'
// events fire (it has no streaming delays like chat mode does). Chat mode never
// awaits this (cli-mode may leave stdin open), so there is no deadlock risk.
let resolveStdinEnd;
const stdinEnded = new Promise((resolve) => {
  resolveStdinEnd = resolve;
});
try {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdinContent += chunk;
  });
  process.stdin.on("end", () => resolveStdinEnd());
  process.stdin.on("close", () => resolveStdinEnd());
  process.stdin.on("error", () => {
    /* stdin may not be readable — fine */
    resolveStdinEnd();
  });
} catch {
  /* no stdin attached — fine */
  resolveStdinEnd();
}

// Env keys worth recording, as an ALLOWLIST — never the whole environment.
// The webServer env is `{...process.env, …}`, so dumping process.env would write
// the developer's entire shell (plus AOA_API_KEY, the per-run token production
// redacts via redactEnvForLogs) in the clear to a fixed, never-swept tmpdir path,
// once per spawn for the whole suite.
//
// The prefixes are what the D9 assertions need: recording the CLASS (not named
// keys) keeps absence proofs honest — a leaked CLAUDE_*/ANTHROPIC_* variable
// nobody enumerated still shows up.
const ENV_RECORD_PREFIXES = ["CLAUDE_", "ANTHROPIC_"];
const ENV_RECORD_KEYS = ["PATH", "Path", "HOME", "USERPROFILE", "AOA_AGENT_ID"];

// The two recorded prefix classes are exactly where Claude's vendor credentials
// live — CLAUDE_CODE_OAUTH_TOKEN (the headless subscription-OAuth token, named
// as a credential at server/src/services/extraction-cli.ts:235) starts with
// CLAUDE_ and is NOT in the poison set that force-overwrites ANTHROPIC_API_KEY,
// so a developer's real one would otherwise be written verbatim.
//
// Mask the VALUE, keep the KEY: every absence proof asserts on key presence, so
// redaction costs nothing. Mirrors what production does via redactEnvForLogs.
const SECRETISH = /(token|api[_-]?key|secret|password|credential)/i;

function recordableEnv() {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const keep =
      ENV_RECORD_KEYS.includes(key) ||
      ENV_RECORD_PREFIXES.some((p) => key.toLowerCase().startsWith(p.toLowerCase()));
    if (keep) out[key] = SECRETISH.test(key) ? "<redacted>" : value;
  }
  return out;
}

// FILENAMES ONLY, never contents — the credential file's whole point is that
// its bytes stay out of a fixed, never-swept tmpdir log. The per-run config home
// is removed in the adapter's `finally`, so this listing (taken here, in the
// child) is the only race-free view of what provisioning actually placed where
// the CLI would read it.
function recordableConfigDirEntries() {
  try {
    return fs.readdirSync(process.env.CLAUDE_CONFIG_DIR).sort();
  } catch {
    return [];
  }
}

// The skills the spawn can actually SEE, listed by name from the child's own
// view of `--add-dir <skillsDir>`.
//
// The adapter materializes `context.skills` into
// `<skillsDir>/.claude/skills/<key with "/"→"--">/SKILL.md` (buildSkillsDir,
// claude-local/src/server/execute.ts:100-113) and passes the parent directory as
// `--add-dir`, which is how the real CLI registers them. skillsDir is removed in
// the adapter's `finally`, so — exactly like configDirEntries — listing it here,
// in the child, is the only race-free proof of what was delivered.
//
// FOLDER NAMES ONLY, never contents.
function recordableSkillDirEntries() {
  const flagIndex = argv.indexOf("--add-dir");
  if (flagIndex < 0 || flagIndex + 1 >= argv.length) return [];
  try {
    return fs.readdirSync(path.join(argv[flagIndex + 1], ".claude", "skills")).sort();
  } catch {
    return [];
  }
}

// Best-effort, never fatal. Called right before exit so any stdin the parent
// piped in (the prompt, post-stdin-delivery) has been received during the turn.
function recordInvocation() {
  try {
    fs.appendFileSync(
      INVOCATIONS_PATH,
      // `env` (additive): the allowlisted slice of the shim's OWN inherited
      // environment. The only place the effect of a spawn-time env strip is
      // observable — asserted by crew-config-isolation.spec.ts. Existing specs
      // read argv/stdin/cwd and are unaffected.
      JSON.stringify({
        argv,
        stdin: stdinContent,
        cwd: process.cwd(),
        env: recordableEnv(),
        configDirEntries: recordableConfigDirEntries(),
        skillDirEntries: recordableSkillDirEntries(),
      }) + "\n",
      "utf8",
    );
  } catch {
    /* recording is best-effort */
  }
}

function readControl() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTROL_PATH, "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // missing/corrupt control file — fall through to the inert default so an
    // unexpected spawn (e.g. a background Commander run) never crashes.
  }
  return { toolCalls: [], text: "Fake claude: no control file found." };
}

// ── Extraction mode detection ─────────────────────────────────────────────
// The extraction-cli spawns: claude --print --system-prompt-file <f>
//   --output-format text
// Commander chat spawns:     claude --print --output-format stream-json …
// Distinguishing factor: extraction mode has "--output-format text" (or
// simply NOT "--output-format stream-json").
const IS_EXTRACTION_MODE = !argv.includes("stream-json");

async function mainExtraction() {
  // Wait for the parent to finish piping the prompt over stdin (and close it)
  // before recording the invocation / emitting output. Bounded by a 2s safety
  // race so a never-closed stdin can't hang the shim. extractViaClaude always
  // closes stdin, so in practice this resolves immediately on EOF.
  await Promise.race([stdinEnded, sleep(2000)]);

  const control = readControl();

  // Forced nonzero exit — simulates CLI crash / auth failure so the extractor
  // marks the entry as "failed".
  if (control.fail === "exit") {
    process.stderr.write("fake-claude: forced nonzero exit for extraction failure test\n");
    recordInvocation();
    process.exit(1);
  }

  // Write the scripted extraction payload to stdout (a JSON array string or
  // any string the caller wants — may be intentionally unparseable).
  const payload =
    typeof control.extractionText === "string" ? control.extractionText : "[]";
  process.stdout.write(payload + "\n");
}

async function main() {
  const control = readControl();
  const toolCalls = Array.isArray(control.toolCalls) ? control.toolCalls : [];
  const text =
    typeof control.text === "string" && control.text.length > 0
      ? control.text
      : "Done.";

  emit({
    type: "system",
    subtype: "init",
    session_id: "fake-claude-session",
    model: "fake-claude",
    cwd: process.cwd(),
    tools: [],
  });

  let i = 0;
  for (const tc of toolCalls) {
    i += 1;
    const id = `toolu_fake_${i}`;
    const name = typeof tc.name === "string" ? tc.name : "mcp__aoa__unknown";

    emit({
      type: "assistant",
      message: {
        id: `msg_fake_${i}`,
        type: "message",
        role: "assistant",
        model: "fake-claude",
        content: [{ type: "tool_use", id, name, input: tc.input ?? {} }],
      },
    });
    await sleep(15);

    const envelope = tc.envelope ?? { success: true, data: null, summary: "ok" };
    emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content:
              typeof envelope === "string" ? envelope : JSON.stringify(envelope),
            is_error: tc.isError === true,
          },
        ],
      },
    });
    await sleep(15);
  }

  // Optional: hold the stream open after the tool_result(s) and before the
  // reply text. Tool-call indicators live only in local streaming state (the
  // assistant message persists content + outputRefs, never toolCalls), so they
  // vanish on the post-turn server sync. The spinner fix (tool_result settles
  // running→done BEFORE the turn's `done`) is therefore a during-stream
  // behavior; holdMs gives a test a window to observe the settled indicator.
  if (typeof control.holdMs === "number" && control.holdMs > 0) {
    await sleep(control.holdMs);
  }

  // Emit a thinking block + delta so e2e specs can assert the reasoning block.
  // Gated behind control.reasoning (optional boolean, defaults true) so callers
  // can suppress it if needed — no existing spec asserts absence of reasoning,
  // so the default is to emit unconditionally (control.reasoning !== false).
  if (control.reasoning !== false) {
    emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Considering the request… " } } });
    emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    await sleep(10);
  }

  // Stream the reply word-by-word via content_block_delta/text_delta — the
  // exact shape handleStreamEvent() consumes.
  const words = text.match(/\S+\s*/g) ?? [text];
  for (const word of words) {
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: word },
      },
    });
    await sleep(5);
  }

  // Full-text assistant event — parse-stream-json.ts skips text blocks in
  // assistant events (text already streamed above); kept for shape realism.
  emit({
    type: "assistant",
    message: {
      id: "msg_fake_final",
      type: "message",
      role: "assistant",
      model: "fake-claude",
      content: [{ type: "text", text }],
    },
  });

  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 60,
    duration_api_ms: 50,
    num_turns: 1,
    result: text,
    session_id: "fake-claude-session",
    total_cost_usd: 0,
    usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 },
  });
}

const runner = IS_EXTRACTION_MODE ? mainExtraction() : main();
runner.then(
  () => {
    recordInvocation();
    process.exit(0);
  },
  (err) => {
    recordInvocation();
    process.stderr.write(`fake-claude failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  },
);
