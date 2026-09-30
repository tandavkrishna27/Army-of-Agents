> Current scope authority: [master scope](master-scope.md). Source revisions, tests and unresolved integration dependencies: [code evidence](code-evidence.md). This companion describes planned behavior unless explicitly evidenced.

# Commander voice — provider and implementation research

## Confirmed product direction

### Confirmed voice–Commander responsibilities

Voice handles listening, speaking and interruption. Commander owns work, decisions and agent coordination under existing permissions. The user sees one conversation. Spoken progress and completion claims must derive from confirmed Commander state; interrupting speech alone does not stop authorized background work. Shared-context delivery, result callbacks and reconnect deduplication remain technical contracts to specify. Do not move into release slicing until the broader technical design has been reviewed.

The user confirmed eventual support for all three approaches, starting with realtime voice:

1. Realtime conversational voice connected to Commander. Evaluate OpenAI realtime voice, Gemini Live, and ElevenAgents; no individual provider selected yet.
2. Composable speech recognition → Commander → speech synthesis, with independently selectable supported providers.
3. Locally running speech components through the same integration boundary. This does not imply an offline hosted AoA control plane.

One durable Commander conversation and governed work authority underlie all modes. Implementation includes interruption, reconnect and delegation tests; a separate prototype is not a prerequisite to continuing design. Release slicing comes later. This decision supersedes earlier tentative recommendations to begin with the separate speech pipeline.

ElevenLabs belongs in both component-provider and managed realtime-platform evaluations. ElevenAgents documents recognition, a chosen/custom LLM, TTS and turn-taking; it is not equivalent internally to a native audio model. Its custom-LLM option still requires a compatible Commander integration, not a claim of existing support. [ElevenAgents overview](https://elevenlabs.io/docs/eleven-agents/overview/), [custom model integration](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm).

Reviewed September 10, 2026. Documentation-based shortlist, not an independent quality benchmark or procurement approval. Scope: voice around the existing Commander. Preserve its conversation, permissions and execution routing. Provider capabilities change; pin and retest model/API versions at implementation.

## Current evidence and version boundary

[September 12 provider evidence](voice-media-provider-evidence.md) and the [D3 policy proposal](voice-media-policy.md) supersede this older shortlist where they conflict. Three V1 voice providers remain required; pipeline/local speech remains E3.4/V2. GPT-Live client delegation is a newly documented OpenAI comparison candidate, not an automatic protocol switch. Earlier framework suggestions are not dependency selections.

## Recommended shortlist

### Architecture comparison — clarification after user review

OpenAI Realtime and Gemini Live are current evaluation candidates, not deferred by default. No measured winner has been established. Compare three backends under one AoA voice-session contract:

| Approach | What we can use | Strength for AoA | Main constraint |
|---|---|---|---|
| Streaming speech pipeline | Deepgram/Scribe/Sarvam → existing Commander → Cartesia/ElevenLabs/Sarvam | One decision-making context; replaceable recognition and output; clear path to local components | Turn detection, streaming and playback cancellation need orchestration; Commander latency remains audible |
| Realtime voice frontend | OpenAI Realtime, Gemini Live or ElevenAgents → governed Commander delegation | Direct audio conversation, native turn handling; can potentially keep the spoken interaction responsive | Two model contexts; spoken claims must match confirmed work; tool wait/cancellation behavior varies by exact model |
| Local speech pipeline | whisper.cpp recognition plus an evaluated local TTS engine such as Piper | Audio processing can stay local; uses the same Commander bridge | Hardware, languages, packaging, model licenses and interruption quality require validation; hosted Commander still requires connectivity |

**OpenAI:** official guidance distinguishes WebRTC-managed interruption/truncation from WebSocket clients, which must stop playback and report the played boundary. This makes transport part of the design, not an interchangeable implementation detail. [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations).

**Gemini:** current documentation lists synchronous-only function calling for Gemini 3.1 Flash Live Preview, versus synchronous/asynchronous support for 2.5 Flash Live Preview. A long Commander tool call can therefore block conversation on the synchronous model. Evaluate a quick accepted-job response followed by a separately correlated result, but do not assume that pattern works without testing or describe acceptance as completion. [Live tools](https://ai.google.dev/gemini-api/docs/live-api/tools). Provider session resumption is documented but does not replace AoA's durable history. [Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management).

**Local:** whisper.cpp includes microphone streaming examples; this alone does not establish production turn-taking. Piper is a local TTS candidate whose repository lists GPL-3.0; engine and selected voice-model terms need packaging review. No claim of Hindi-English parity or offline AoA operation follows. [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [Piper](https://github.com/OHF-Voice/piper1-gpl).

**Framework:** LiveKit remains a candidate for both pipeline and realtime modes. Its documentation notes that realtime models with server-side turn detection do not use all the same interruption settings as pipeline models. Adapter capability and version checks are mandatory. [Turn handling](https://docs.livekit.io/agents/logic/turns/).

### Common contract and interruption behavior

- One durable AoA conversation and governed action path; provider sessions are replaceable connections.
- Track utterance identity, provisional/final text, response generation, played-audio boundary and delegated request identity separately.
- On barge-in: stop local playback, cancel or invalidate remaining audio, reconcile the provider's heard context, then accept the next utterance. Late audio from the old generation is discarded.
- Stopping speech does not cancel a committed task. An explicit work cancellation uses the existing governed command and reports its actual outcome.
- Reconnect restores authorized conversation context and checks pending requests; never blindly reissues tools. Provider change occurs at a clean boundary, not by hot-swapping an active model object.
- Local audio processing is a deployment capability. It does not make the hosted control plane or Commander offline. Route local speech through an approved desktop capability when implemented, not an arbitrary host-spawn fallback.

**Recommendation:** design both pipeline and realtime adapters now and evaluate OpenAI and Gemini alongside the pipeline. Keep a local adapter seam from the start. Select the default using identical natural-interruption, long-task, recovery, mixed-language and cost scenarios during implementation. Multi-provider support means supported capability profiles, not guaranteed identical behavior from every model.

| Candidate | Role in the evaluation | Evidence / reason |
|---|---|---|
| Deepgram | Streaming recognition; evaluate multilingual Flux | Current model documentation includes Hindi in multilingual Flux. Do not repeat the older English-only conclusion. [Models and languages](https://developers.deepgram.com/docs/models-languages-overview), [code-switching configuration](https://developers.deepgram.com/docs/voice-agent-stt-models). |
| ElevenLabs | Alternative recognition using Scribe Realtime; spoken-output candidate | Streaming recognition and explicit transcript commit strategies are documented. Treat claimed latency as vendor-reported, not end-to-end Commander latency. [Speech recognition](https://elevenlabs.io/docs/overview/capabilities/speech-to-text/), [commit strategies](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies). TTS model-specific cancellation and language support still need adapter review. |
| Cartesia | Streaming spoken-output candidate | Bidirectional text/audio streaming and per-utterance contexts are documented. Useful comparison for responsive output. [Streaming quickstart](https://docs.cartesia.ai/get-started/realtime-text-to-speech-quickstart), [contexts](https://docs.cartesia.ai/use-the-api/tts-websocket/contexts). |
| Sarvam | Indian-language recognition and spoken-output candidate | Saaras supports code-mixed speech; Bulbul supports streaming output. Include for Hindi-English evaluation, without assuming superior accuracy from positioning. [Models](https://docs.sarvam.ai/api/getting-started/models), [streaming speech](https://docs.sarvam.ai/api-reference/text-to-speech/stream). |
| Google Gemini Live | Alternative realtime voice architecture | Session management is documented; keep it separate from replaceable STT/TTS. A voice model introduces another model context and must delegate governed actions to Commander. [Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management?hl=en). |
| OpenAI Realtime | Alternative realtime voice architecture | Candidate for comparison with the speech pipeline, not the selected Commander replacement. Review audio/conversation cancellation and truncation before integrating. [Realtime reference](https://platform.openai.com/docs/api-reference/realtime?lang=javascript). |

This is a focused candidate set, not a claim to cover every vendor. No paid calls, subscriptions or credentials were used. Exact prices, regional processing guarantees, retention terms and concurrency allocations are not verified by this review and remain required before selecting supported presets.

## Frameworks: how others assemble the experience

**LiveKit** is the first framework candidate: its documentation explicitly addresses early cutoff, false interruptions, turn detection and speculative generation. It offers pipeline hooks that we could adapt to Commander. Recommendation is based on architectural fit, not a measured performance advantage. [Turn-taking troubleshooting](https://docs.livekit.io/agents/logic/turns/tuning/), [pipeline hooks](https://docs.livekit.io/agents/logic/nodes/).

**Pipecat** is the comparison candidate: provider adapters and frame-based audio pipelines explicitly handle interruption and pipeline control. Its integration guidance distinguishes services that support interruption/context controls from those requiring reconnect, showing why a generic provider switch alone is insufficient. [Pipeline](https://docs.pipecat.ai/pipecat/learn/pipeline), [services](https://docs.pipecat.ai/api-reference/server/services/supported-services), [adapter guidance](https://github.com/pipecat-ai/pipecat/blob/main/COMMUNITY_INTEGRATIONS.md).

Evaluate one framework, not both in production. Do not copy either framework's agent orchestration as a second AoA scheduler. A custom thin pipeline remains possible, but takes ownership of more media, interruption and recovery behavior.

## Documented lessons and AoA implications

1. **Silence does not always mean a finished thought.** LiveKit's troubleshooting describes premature cutoff and false interruption from short acknowledgements. Use separate end-of-turn and interruption rules; test natural pauses and code-switching. Do not simply lower all delays. [Turn-taking tuning](https://docs.livekit.io/agents/logic/turns/tuning/).
2. **Stopping audio is only part of interruption.** LiveKit documents reconciling conversation history with what was heard. AoA should preserve its full written response while tracking which spoken portion reached the user; never infer they heard the remainder. A speech interruption must not automatically cancel already-authorized work. [Interruptions](https://docs.livekit.io/agents/logic/turns/).
3. **Partial transcription is not a command.** ElevenLabs exposes commit strategies. Display partial text as provisional; submit a finalized utterance once through Commander's deduplication path. [Transcript commits](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies).
4. **Streaming needs utterance identity.** Cartesia documents stable contexts for streamed text. Keep an utterance generation identifier so late audio from a cancelled response cannot play after a new response starts. [Endpoint comparison](https://docs.cartesia.ai/use-the-api/compare-tts-endpoints).
5. **Long sessions require explicit lifecycle handling.** Gemini documents session management. Keep the durable AoA conversation independent of provider connection lifetime, and resume/reconnect without silently submitting the same user request again. [Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management?hl=en).
6. **Adapters have different interruption behavior.** Pipecat distinguishes reconnect-based services from context-aware ones. Define a capability matrix, rather than promise every provider combination behaves identically. [Integration guidance](https://github.com/pipecat-ai/pipecat/blob/main/COMMUNITY_INTEGRATIONS.md).
7. **Advertised model latency is not conversational latency.** Measure capture, endpointing, recognition, Commander startup/thinking, synthesis and playback separately. Speculation may reduce delay but wastes cancelled generation and must not trigger business side effects. This is our inference from the pipeline and tuning documentation, not a cross-vendor benchmark.

These are documented failure patterns and design lessons, not claims that named vendors suffered a verified production incident. Unverified community billing and quality anecdotes were not treated as evidence.

## Proposed supported experience

- Simple presets by default; advanced settings can choose recognition and output providers independently. Only advertise combinations that passed the compatibility suite.
- Server-side credentials or provider-approved short-lived browser tokens, scoped to the user/organization. Never embed durable provider keys in generated panels.
- Provider adapter capabilities include languages, partial/final transcripts, turn signals, cancellation, timestamps, audio formats, reconnect, usage and limits.
- Change providers at a clean turn boundary. Keep the conversation; drain/cancel old audio and prevent duplicate submission. Do not silently move audio to an unapproved fallback provider.
- Separate mute, stop speaking and disconnect. Show connection state; measure billable behavior rather than assume silence costs nothing.
- Realtime is the initial integration direction: evaluate OpenAI, Gemini and ElevenAgents. Component-mode comparisons can include Deepgram/Scribe/Sarvam recognition and Cartesia/ElevenLabs/Sarvam output. These remain candidates, not validated integrations or a requirement to begin with the component pipeline.
- During implementation, test interruptions, acknowledgements, Hindi-English mixing, background noise, slow Commander, provider failure and long idle sessions. Compare correctness and total session cost alongside latency and voice quality.

## Remaining decisions

No new user decision is needed to continue architecture. Multi-provider support and optional connected credentials are already the direction. Before implementation acceptance, verify each chosen provider's exact TTS model, API limits, pricing including idle behavior, regional availability, retention, credential model and current framework plugin compatibility. Local speech remains an independent deployment evaluation; this shortlist does not promise local parity.

## Follow-up policy clarification

TK confirmed conversation transcripts retained by default and raw-audio recording in AoA only by explicit opt-in. Provider retention is independently disclosed and verified. Multilingual support is not limited to English/Hindi; those are recommended representative acceptance fixtures. No language restriction or unverified parity promise is introduced. Existing provider research was not re-browsed in the source-alignment pass; recheck current models, capabilities, costs and regions at selection.
