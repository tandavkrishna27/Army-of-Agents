# Universe: Commander context review

September 11, 2026. Read-only source review; no runtime tests were executed for this review.

## Evidence

The existing Commander CLI path in `server/src/services/internal-agent/agent-loop.ts` retrieves conversation messages after the summary marker (limit 50), performs scoped memory recall, and assembles persona, summary, page context and recalled memory with a configured context budget. This is an actual call path, not only a helper definition.

`conversation.ts` persists messages and has `summarizeIfNeeded`, which reads the older message prefix above its threshold and stores a summary with an up-to message marker. `working-memory.ts` implements scoped, role-controlled working memory with expiry. `memory-recall.ts` implements bounded policy-based recall and audit recording. `cli-mode.ts` has provider-specific conversation continuity, including Codex resume handling; this is not a universal voice-session persistence mechanism.

The conversation, context-assembly, working-memory and memory-recall files have no diff between local HEAD and the inspected local replatform tracking ref. This confirms source reuse at those refs, not delivery or behavior of every distributed call path. Existing tests are evidence of intended cases only unless actually run.

## Recommendation

Extend this context assembly path. Do not introduce an independent Universe memory database or treat a realtime provider's conversation as authoritative history.

Add a bounded Universe context envelope: stable selected item references, source/artifact versions, permitted current panel values, conversation identity, and context revision. A page-context string alone does not establish this contract. Resolve deeper artifact/history references through governed retrieval. Fetch current job status from the work system rather than treating a summary as fresh execution truth.

## Gaps to resolve before final acceptance design

- Define exactly how the CLI/replatform Commander path and realtime adapter consume the same versioned context envelope.
- Define explicit corrections and superseded decisions in summaries, with source references and retrieval of the original exchange when needed.
- Audit summarization cost and concurrency: the current helper reads an older prefix, so incremental processing and stale summary overwrite prevention need explicit review rather than assuming a marker solves both.
- Allocate context budgets across recent exchanges, summary, selection and retrieved evidence; preserve critical target/permission identity instead of truncating it away.
- Test fresh-session recovery after provider resume fails: database context must reconstruct the user-visible conversation sufficiently, with no duplicate action replay.
- Verify scoped recall, late result routing and selection revisions across concurrent canvases and voice-session switches.

No additional product decision is needed to investigate these mechanics. The next architecture output should be a concrete context envelope and recovery contract with acceptance cases, followed by dependency mapping into epics.
