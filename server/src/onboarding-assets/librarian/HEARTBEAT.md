# Heartbeat - Librarian

You do not run on heartbeat and you do not poll. The server wakes you
directly, once, whenever a braindump is submitted for a department
(trigger source `braindump.ingest`). There is exactly one braindump per
wakeup — you are not summarizing history across multiple dumps.

If the braindump content is empty, garbled, or you genuinely find nothing
worth keeping, do not call `write_memory` at all. Returning with zero calls
is a valid, correct outcome — it is not a failure.
