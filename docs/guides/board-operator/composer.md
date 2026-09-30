---
title: Compose Messages and Comments
summary: Draft, mention, attach, send, retry, and control work from AoA's shared composer
---

AoA uses the same composer contract in Commander, Discussions, and task comments. The controls vary by surface, but drafts, attachments, submission identity, and failure recovery follow the same rules.

## Write and Attach

Enter text normally, use `@` to select a company agent where mentions are available, and use the attachment control or drag files onto the composer.

Composer uploads accept up to five files per submission and 10 MB per file:

- PNG, JPEG, WebP, and GIF images
- PDF
- Plain text and Markdown
- JSON

The server verifies the file bytes as well as the declared content type. A rejected or cross-company asset is not attached.

Commander can read up to 32 KB from plain-text, Markdown, and JSON attachments during the turn. Images and PDFs are stored and identified to Commander, but their contents are not delivered to the current runtime. See [Commander attachment runtime](../../architecture/commander-attachment-runtime.md).

## Drafts and Offline Work

Drafts are stored locally for seven days. They are scoped to the signed-in user, company, surface, record, and reply target, so a reply draft does not overwrite a top-level post. AoA stores safe attachment references, not file bytes, in the draft.

When the browser is offline, the draft remains available but Send is disabled. Reconnect, review the retained text and attachments, and send it explicitly.

## Send and Retry

Every submission receives a client-generated submission ID. Retrying the same accepted submission returns the existing result instead of creating another message or comment. The server also resumes any incomplete follow-up effects, such as a mention wake-up, without duplicating the content.

If a request fails before the server accepts it, the composer retains its text, tokens, and completed uploads. Use:

- **Retry** to resend the same submission
- **Edit** to return to the draft before sending again
- **Discard** to abandon the failed submission

These controls are locked while a retry is in progress.

## Surface Differences

### Commander

Commander supports company-agent mentions, skill tokens, attachments, and streamed responses. Type `/` or use the add menu to insert a skill token. The visible token expands to a governed `use_skill` directive when sent. See [Work with Commander](commander.md).

### Discussions

Discussion posts and replies may contain text, attachments, or both. Agent mentions are resolved when the entry is accepted and queued for durable delivery. Mentioning an agent can wake it; delivery is retried by the server, so do not repeatedly repost on a slow response. See [Discussions](discussions.md).

### Task Comments

An ordinary task comment does not interrupt an active run. Depending on task state and your permissions, the composer can instead:

- **Wake and send** to queue work for the assignee
- **Interrupt and send** to cancel the active run before delivering the comment
- **Reopen and send** for a closed task

Attachments may be sent without comment text. AoA applies the same retry identity to the comment, its files, and its control effects.
