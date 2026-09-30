# W1 Spike — Windows `claude` prompt-delivery (Task 1 findings)

**Date:** 2026-06-25 · **Host:** Windows 11 · **Method:** Node `spawn("claude", args, { shell:true, cwd:tmpdir() })` mirroring `cli-mode.ts`, 35s cap per shape. Prompt: *"Reply with exactly the word READY and nothing else."* Signal = did stdout actually contain `READY` (prompt delivered) vs unrelated output (prompt lost).

## Results

| Shape | Prompt delivery | exit | stdout len | answered READY? |
|---|---|---|---|---|
| 1. `--print "<prompt>"` | argv | 0 | 102 | ❌ NO |
| 2. `--print` + stdin (close) | stdin | 0 | 6 | ✅ YES |
| 3. `--print "<prompt>"` + empty stdin write | argv | 0 | 178 | ❌ NO |
| 4. `--print --output-format stream-json --include-partial-messages --verbose "<prompt>"` | argv | 0 | 27590 | ❌ NO |
| 5. same as 4 but prompt on stdin (close) | stdin | 0 | 23049 | ✅ YES |

## Conclusion (root cause confirmed)

On Windows, the prompt passed as an **argv positional through `shell:true`/cmd.exe is NOT delivered** to `claude` — the process runs (exit 0, non-empty output) but answers something unrelated to the prompt. This is the reported "empty/garbage Commander turn" bug. **Delivering the prompt over stdin works** in both plain `--print` and the Commander `stream-json` shape.

## Decisions for implementation (W1 / Task 3 + W2 / Task 5)

1. **Deliver the prompt via stdin, never argv.** Remove the user-content argv positional + its Windows escaping.
2. **One-shot extraction (W2):** `claude --print --output-format text` (no `--mcp-config`), system/instruction via `--system-prompt-file`, **content written to stdin then `stdin.end()`** (close). Proven by shapes 2/5.
3. **Commander chat (W1):** turn 1 writes the prompt to stdin (proven by shape 5) instead of argv. NOTE: multi-turn persistence (claude `--print` exiting after one response vs staying alive for subsequent stdin turns) is NOT settled by this spike — verify during Task 3 implementation: if `--print` exits per turn, switch Commander to spawn-per-turn (one-shot semantics) rather than a persistent process. Either way, turn-level delivery is stdin.
4. `codex exec --json -` already uses stdin (works); no change needed for codex delivery.

## Follow-up to verify in Task 3
- Persistent claude chat: does `--print` with stdin held open process multiple turns, or exit after one? If it exits, adopt spawn-per-turn for Commander.
