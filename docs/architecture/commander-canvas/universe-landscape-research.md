# Universe: comparable workspaces and implementation references

Research date: 11 September 2026. Army of Agents is the product; Universe is the proposed feature name. This report informs the [master scope](master-scope.md), without adding competitors' capabilities to the committed scope.

## Finding

Yes, closely related interfaces exist. Spatial AI conversation, agents on a canvas, persistent agent workspaces, embedded research browsers, and generated interactive content all have public examples. Universe should not be positioned as the first AI canvas.

The opportunity is the quality of the combined experience: one Commander conversation coordinating real organizational work, clear human control, durable artifacts, useful proactive behavior, and a calm workspace usable throughout the day. This is a product hypothesis, not a proven competitive advantage. I did not establish that another product delivers our entire combination, but absence from public documentation does not establish absence from a product.

This is public-source research across official product pages, documentation, repositories, and a reported issue. It is not an installed-product usability test, security audit, or proof that every README claim works. Availability, licensing, and implementation maturity are treated separately. An infinite-canvas screenshot alone does not establish voice quality, reliable execution, or organizational isolation.

## Closest references

The relevance judgments below are our assessment; the linked descriptions are the evidence.

| Reference | Documented overlap | Most useful for Universe | Evidence boundary |
|---|---|---|---|
| [Flowith Canvas](https://flowith.io/tools/canvas/) | Sources, conversations and outputs arranged as branched visual work | Explore alternatives without losing the main task; bring selected results together | Product description, not verification of our voice or browser-control contract |
| [Miro Sidekicks](https://help.miro.com/hc/en-us/articles/29902701849618-Sidekicks-overview) | Canvas-aware agents, visible agent cursor, board interaction and asynchronous suggestions | Show what Commander understands and where it acts | Documented behavior; specific account availability can vary |
| [OpenCove](https://github.com/DeadWaveWave/opencove) | Agents, terminals, tasks and notes on one persistent spatial workspace | Parallel work visibility and returning to the same arrangement | Repository describes alpha status despite stable release channels |
| [Kosmik browser](https://www.kosmik.app/faq/browser-and-built-in-web-capture) | Browser beside canvas, captured material retaining source links | Research while keeping documents and references in view | Human research workflow; governed agent takeover not established |
| [Buzz](https://github.com/block/buzz/blob/main/README.md) | Humans and agents in shared communication, threads and canvases | Deferred Discussions and shared-workspace direction | README separates working features from unfinished integrations |
| [AFFiNE](https://github.com/toeverything/AFFiNE) | Documents and edgeless knowledge workspace | Movement between readable material and spatial organization | Adjacent knowledge product, not evidence of Commander orchestration |
| [AgentWorkspace](https://github.com/IljaZakharov/AgentWorkspace) | Agent/human room, canvas, chat and optional voice integration | A particularly close conceptual interaction reference | Explicit demo snapshot/pet project |
| [dim0](https://github.com/vcmf/dim0) | Collaborative board with notes, mini-apps and agents | Interactive surfaces within shared spatial context | README capabilities and performance claims not independently tested |
| [Cognograph](https://github.com/skovalik/cognograph) | Persistent conversation/task/artifact nodes and graph-derived context | Inspectable context, semantic zoom and artifact previews | Public implementation reference, not an audited production dependency |
| [Caudalflow](https://github.com/caudal-labs/caudalflow) | Branching AI conversations and merging insights | Side explorations that return to a main conversation | Narrower conversational canvas, not a complete work operating system |

## What to learn from the closest products

### Flowith: branching without losing the task

Flowith describes spatial branches for research, planning, creation and review, with sources and results kept visible. That makes it one of the strongest references for the idea of working around a conversation instead of reading an indefinitely growing transcript. [Product description](https://flowith.io/tools/canvas/)

For Universe, the useful question is how to expose alternatives only when they help. A user asking for another design should be able to compare it with the original and retain the preferred version. The user should not need to wire a workflow graph for ordinary requests. Branches should have clear names, provenance and an obvious route back to the main work.

### Miro: the agent has a visible relationship to content

Miro documents Sidekicks operating with board context and an agent cursor. Its workflow documentation describes agents and connected generation steps producing board content. Those are substantial overlaps with Commander highlighting selections and creating useful material in place. [Sidekicks](https://help.miro.com/hc/en-us/articles/29902701849618-Sidekicks-overview), [AI workflows](https://help.miro.com/hc/en-us/articles/29722516406546-Miro-AI-Workflows-overview)

Miro announced two-way voice in May 2026, but its May update also distinguishes available features from upcoming rollout. The reviewed evidence is insufficient to label every announced voice feature generally available today. [Announcement](https://miro.com/newsroom/miro-takes-aim-at-the-gap-between-ai-potential-and-organizational-reality/), [Rollout context](https://miro.com/blog/whats-new-may-2026/)

Recommendation: make Commander's current target visible before consequential changes. A pointer is useful when it explains attention or action. Constant decorative movement would compete with reading. Also distinguish a proposal, an action in progress, and a confirmed result visually.

### OpenCove: parallel work as an actual workspace

OpenCove describes side-by-side coding agents, terminals, tasks and notes, persistent layouts, workspace archives and search. Its current README identifies it as alpha and mentions newer stable builds; release labeling should not be mistaken for enterprise readiness. [Repository](https://github.com/DeadWaveWave/opencove)

This is a strong reference for our Work cards and open-panel navigation. Universe should retain the task owner and status when details are collapsed, with search bringing an existing item forward. Its audience is broader than developers, so raw terminals and individual agent sessions should not become the default view for every worker.

### Kosmik: sources remain attached to what you captured

Kosmik documents a built-in browser with tabs and capture into the canvas, preserving the relationship to the original page. It also describes focused inspection alongside other material. [Browser help](https://www.kosmik.app/faq/browser-and-built-in-web-capture), [Browser explanation](https://www.kosmik.app/blog/kosmik-browser)

This supports our separation of Artifacts & Sources from open panels. Opening and closing a source should not create another copy. A captured excerpt needs a source link; a generated artifact needs its producing task and version. Research browsing and automated browser execution can share presentation patterns while retaining different control rules.

### Buzz: the shared communication extension

Buzz's README describes rooms, threads, direct messages, canvases, agent tooling and workflows. It explicitly separates working functionality from items still being connected, including workflow approval gates and huddle lifecycle events. [README](https://github.com/block/buzz/blob/main/README.md)

It is especially relevant to the future Discussions workstream. We should learn from shared conversation and work context without making that broader communication rebuild a prerequisite for personal Universe. A source thread, a task and an artifact should keep stable identities when viewed from more than one workspace.

## GitHub ideas worth studying, without adopting their whole runtime

**AgentWorkspace** is unusually close to the conversation-plus-canvas-plus-voice concept, but explicitly presents itself as a demo snapshot. Its documented local JSON state and room integrations are useful for reading a small end-to-end example, not evidence of our required recovery and tenancy guarantees. [Repository](https://github.com/IljaZakharov/AgentWorkspace)

**dim0** brings collaborative notes, mini-apps and agents together. Study how selected board context reaches the agent and how generated surfaces appear alongside ordinary content. Do not adopt its performance claims or backend choices without measurements and source-level review. Our full application-generation capability remains deferred. [Repository](https://github.com/vcmf/dim0)

**Cognograph** describes graph-based context assembly, live HTML artifact previews, progressively detailed rendering as users zoom, and proposed canvas changes. These are useful design references. For Universe, graph-derived context must remain permission-filtered and inspectable; proximity or a connection cannot authorize access. [Repository](https://github.com/skovalik/cognograph)

**Caudalflow** focuses on branching and returning insights to a main conversation. Borrow the clarity of a side exploration's destination rather than introducing another compulsory navigation hierarchy. [Repository](https://github.com/caudal-labs/caudalflow)

**AFFiNE** is worth studying for document/edgeless transitions and organizing accumulated material. It is a broader knowledge-work reference rather than a substitute for our execution system. [Repository](https://github.com/toeverything/AFFiNE)

Public source availability is not a blanket reuse license. Before copying implementation, check the exact revision's license, dependency licenses, notices and integration constraints. This research does not approve any repository as a dependency.

## Building blocks: a different decision from product inspiration

| Candidate | What it contributes | Recommended treatment |
|---|---|---|
| [tldraw agent starter](https://tldraw.dev/starter-kits/agent) | Canvas-aware agent interaction, contextual actions and extensible canvas behavior | Strong reference if Universe needs whiteboard-style editing; evaluate against rich document and browser panels |
| [React Flow custom nodes](https://reactflow.dev/learn/customization/custom-nodes) | React content inside draggable/selectable nodes | Strong candidate to evaluate for mixed cards and panels; avoid exposing graph handles everywhere merely because the library supports them |
| [AG-UI](https://docs.ag-ui.com/introduction) | Event-based agent/application interaction | Compare with our existing request/result contract; do not create a competing execution authority |
| [A2UI](https://a2ui.org/introduction/what-is-a2ui/) | Declarative descriptions rendered through a component catalog | Relevant to trusted generated tools; schema validation and AoA permissions remain necessary |

tldraw's production SDK requires a license key. Treat its licensing as an explicit selection input, not an assumption based on its public repository. [License documentation](https://tldraw.dev/community/license)

React Flow documents visible-element rendering and viewport serialization. These are useful primitives, not complete autosave, live-data recovery or conflict-resolution solutions. Universe still owns those contracts. [Rendering options](https://reactflow.dev/api-reference/react-flow), [Instance serialization](https://reactflow.dev/api-reference/types/react-flow-instance)

AG-UI and A2UI address different layers: communicating agent state versus describing a UI surface. Neither alone implements the Universe workspace, durable jobs, approval enforcement, or browser session ownership. The recommendation is a compatibility assessment before adding either protocol.

## Concrete cautions and resulting acceptance checks

The following are design implications, not claims that all referenced products fail these checks.

| Evidence or distinction | Implication for Universe | Acceptance check |
|---|---|---|
| A Buzz issue reports replies appearing then disappearing after channel re-entry | A stale snapshot must not overwrite newer events | Receive a result during restore; verify it remains visible exactly once after synchronization |
| Miro's announcement and rollout descriptions differ in availability | Feature lists must distinguish planned from usable | Mark adapter capability as implemented, tested or unavailable; do not render an enabled control for an absent backend |
| OpenCove identifies alpha maturity | A compelling workspace does not establish durable operation | Restart during work; recover layout, job identity and confirmed results independently |
| AgentWorkspace identifies demo status | A compact demo is not an enterprise architecture | Exercise cross-company access, expired permissions and concurrent sessions against AoA |
| Generated UI protocols describe surfaces, not authority | Button appearance cannot confer permission | Reject a generated action outside the granted capability even if its UI renders correctly |

The Buzz report is an operator-reported issue, not a reproduced finding from this research. It is useful as a concrete failure scenario rather than a verdict on the product. [Issue report](https://github.com/block/buzz/issues/5643)

## What this should change in our design

Keep the agreed foundation: one Commander conversation, durable work outside panel lifetimes, narrow generated-tool permissions, source provenance, and clear manual browser takeover. The research supports these directions but does not validate their implementation.

Refine the mock around five behaviors:

1. **Focus and return:** inspect an artifact, briefly visit another task, then return without rebuilding the arrangement.
2. **Visible context:** show the selected material Commander is using; adding a panel does not silently add everything it contains to every agent's context.
3. **Quiet parallel work:** keep owner and status visible while finished outputs wait for attention rather than replacing active content.
4. **Source continuity:** one underlying artifact can be opened from a task, search or Artifacts & Sources without duplication.
5. **Progressive detail:** small previews summarize; readable panels expand. Voice captions and the dock should not consume the working area.

Keep the FUI-inspired aesthetic subordinate to those behaviors. The research does not establish an ideal top-versus-bottom dock placement, orb animation style, or caption size. Those remain questions for our own visual walkthrough, particularly at crowded screen sizes and during long sessions.

The most valuable differentiation to validate is whether a user can direct several pieces of organizational work through one coherent Commander interaction, leave, and return knowing what happened. A canvas alone is already well represented in the market.

## Recommended next comparison

Use the same scenario for each reference rather than compare home-page screenshots: open a source, request work, inspect output beside its task, change one requirement, switch away, and return.

Prioritize Flowith for branching, Miro for target visibility, OpenCove for parallel work, and Kosmik for research panels. Review Buzz separately when the Discussions foundations are planned. AgentWorkspace and dim0 are useful technical experiments to inspect after the product patterns, with source and license review before reuse.

No further product decision is required from the user to use this research. The next engineering choice is a bounded canvas-engine comparison against our existing panel requirements, not adoption of an entire external agent platform. Full interactive product testing, exact source-code reuse assessment, and performance/security validation remain outside this public-document research.
