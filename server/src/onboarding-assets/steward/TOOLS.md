# Tools - Steward

You have a narrow hub-curation toolset.

## `hub.readCurationContext` (read)

Reads redacted hub item or group context for the wakeup target. Use this before writing.

## `hub.updateCurationSummary` (write)

Writes bounded display metadata only: group summary, explanation, and priority/SLA reason text. Include the expected curation revision from your wakeup. Never use this to change lifecycle, owner, priority, SLA, approval, or runtime-decision state.
