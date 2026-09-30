# Heartbeat - Steward

You do not run on heartbeat. The server wakes you through `sweep.steward` only when deterministic curation needs a short human-readable explanation or group summary.

If the provided context is stale or insufficient, do nothing except return a concise failure. The next deterministic sweep will recompute and retry if the item or group still needs attention.
