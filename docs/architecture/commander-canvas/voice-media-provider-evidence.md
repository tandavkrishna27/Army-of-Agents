# Voice and media — provider evidence, September 12, 2026

**Documentation research only.** Official pages were read on September 12, 2026. No account, secret, provider session, subscription or SDK was accessed. These are documentary candidates, not tested capability records. Recheck exact model availability, account entitlement, region, price and deprecation at qualification. This supersedes older vendor assumptions only where explicitly stated; all three V1 voice providers remain required.

## OpenAI voice

The current Realtime guide uses gpt-realtime-2.1. WebRTC supports server-created calls through /v1/realtime/calls and client-secret issuance through /v1/realtime/client_secrets. A server sideband connection can attach to a call; it is not itself evidence that every client override or active-call revocation is enforceable. Candidate: backend-created WebRTC call with governed server-side delegation, conditional on verified stop and budget enforcement. [Realtime](https://developers.openai.com/api/docs/guides/realtime), [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc), [server controls](https://developers.openai.com/api/docs/guides/voice-server-controls).

New comparison candidate within the OpenAI provider: GPT-Live client delegation fits an existing separate orchestrator. Its delegation event provides metadata, not an already finalized task instruction; AoA must reconcile transcript/context before canonical submission. It has different event/playback semantics from Realtime. Compare this candidate in E3.1 rather than silently exchanging APIs or using its managed Responses backend as Commander. No default model is finalized. [GPT-Live](https://developers.openai.com/api/docs/guides/live), [delegation](https://developers.openai.com/api/docs/guides/live-delegation), [migration](https://developers.openai.com/api/docs/guides/live-migration).

OpenAI's data table lists Realtime with no training use, 30-day abuse-monitoring retention, no application-state retention and ZDR eligibility. Eligibility is not account enablement. GPT-Live has a separate storage/retention row. Regional support must be checked for the specific endpoint/model/project. Do not infer zero retention from AoA recording being off. [Data controls](https://developers.openai.com/api/docs/guides/your-data).

## Gemini Live

Candidate model: gemini-3.1-flash-live-preview. Current tools documentation says 3.1 supports synchronous function calls; 2.5's asynchronous support must not be attributed to 3.1. A quick accepted-request result followed by later confirmed work is an AoA proposal requiring a real delayed-delivery test. A synchronous wait must not be presented as background completion. [Tools](https://ai.google.dev/gemini-api/docs/live-api/tools).

Browser ephemeral tokens are documented as preview, Live-only, with uses and session/config constraints. The defaults distinguish the window for starting a session from token lifetime. Existing connections need resumption around their documented connection limit; a resume handle is not new AoA authorization. Recommended qualification starts with an AoA-controlled server WebSocket relay; direct browser access requires equivalent enforceable termination and budget proof. [Ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens), [session management](https://ai.google.dev/gemini-api/docs/live-api/session-management).

Paid-service terms apply to Gemini API accessed through a project with active billing; paid prompts/results are not used to improve products, but limited safety/legal logging and nonlocal processing can remain. Unpaid-service treatment and regional exceptions differ. Proposed AoA baseline uses a verified paid project, never infers paid terms from an unrelated subscription or AI Studio login. A strict regional/ZDR deployment must separately establish compliance. [Current terms](https://ai.google.dev/gemini-api/terms).

## ElevenLabs / ElevenAgents

Authenticated signed WebSocket URLs expire for new connection establishment after 15 minutes; existing calls can continue. A URL authenticates access to an agent, not an AoA user or destination. Recommended controlled relay keeps this reusable credential off the browser. A direct client optimization needs its own revocation/reuse proof. Domain allowlisting is not a substitute for AoA authentication. [Authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication).

Client tools provide a bridge, while contextual_update supplies background context and does not promise immediate spoken delivery. Recommend governed delegation with canonical status responses first. A custom-LLM interface is not assumed compatible with Commander SSE and is not selected as an unauthenticated workaround. Test delayed result, duplicate callbacks and interrupted speech explicitly. [Client tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools), [client events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-to-server-events), [custom LLM](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm).

The documented default conversation retention is two years and can be configured separately for text and audio; zero days means scheduled deletion, not immediate zero retention. Enterprise ZRM is a separate feature with model/tool restrictions. Propose shortest supported retention with recording disabled and verified per-agent settings before enabling the connection; never accept vendor defaults silently. [Retention](https://elevenlabs.io/docs/eleven-agents/customization/privacy/retention), [ZRM](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode).

## Media candidates and lifecycle changes

- Images: qualify OpenAI Images generation/edit first using its dedicated operation. The current guide/pricing includes GPT Image 2.5 variants. This is a candidate family, not permission to use a general text/tool endpoint for agent execution. Input images require source authorization; output requires E4 validation/publication. [Image guide](https://developers.openai.com/api/docs/guides/image-generation).
- Generated audio: qualify ElevenLabs TTS for narration and separately qualify any retained music/sound-effect capabilities. Subscription and product rights differ; do not infer commercial rights or ZRM across all products. Default to licensed catalog voices; cloning is not added by this policy. [API pricing](https://elevenlabs.io/pricing/api), [music API](https://elevenlabs.io/eleven-music-api).
- Video: qualify Veo 3.1 as the initial candidate, subject to account/region/size requirements. Its operation lookup enables observation after a known operation ID. Generated downloads expire after two days, so E4 must copy and validate permitted output promptly; losing the admission response before obtaining an ID still has an unknown-outcome case. [Veo](https://ai.google.dev/gemini-api/docs/veo).
- **Exclude Sora from new implementation selection:** OpenAI documents shutdown of Sora 2 and Videos API on September 24, 2026. A still-visible price/model page does not reverse that notice. Video stays V1 through a supported qualified provider. [Deprecation notice](https://developers.openai.com/api/docs/guides/video-generation).

## Price evidence and comparison limits

Public USD list prices observed, excluding tax, discounts, backend Commander work, storage and relay infrastructure. These are not spending approvals or promises of end-to-end cost.

| Candidate | Observed charging basis |
|---|---|
| OpenAI gpt-realtime-2.1 | Per million audio tokens: input $32, cached input $0.40, output $64; text input $4/output $24. GPT-Live lists $0.05/minute, billed per second, with backend usage separate |
| Gemini 3.1 Flash Live Preview | Paid audio input $3/output $12 per million tokens; text input $0.75/output $4.50. Compare measured usage, not silence-free assumptions |
| ElevenAgents | Call-minute plans; published additional calls $0.08/minute, burst $0.16, with LLM charges separate. Plan entitlement and concurrency apply |
| Veo 3.1 | Paid output-second pricing varies by tier/resolution; Fast 720p lists $0.10/second, Standard 720p/1080p $0.40/second |
| Images / audio files | Model, output size/quality or product-specific units; freeze the exact tariff with the chosen preset rather than copying a voice price |

Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [ElevenAgents pricing](https://elevenlabs.io/pricing/agents). Rates need revalidation before any authorized paid trial.

## Research limitations

No account-level retention/region settings, commercial entitlement, active-call termination, billing accuracy, concurrency, language accuracy, actual SDK version or provider/Commander compatibility is certified here. Official mixed-product pages must be read in their Realtime versus GPT-Live section; do not combine their event names. Browser keys, signed URLs and resume handles are secrets even when short-lived. The [policy proposal](voice-media-policy.md) and existing E3/E4 plans define the tests and acceptance boundary.
