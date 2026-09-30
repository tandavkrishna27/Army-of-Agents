---
title: Managing Artifacts
summary: Create, review, version, download, and archive company deliverables
---

Artifacts are durable deliverables produced by your company: reports, documents, designs, presentations, code, and other files. Unlike a discussion message or task comment, an artifact has a current version and immutable version history.

## Create or Find an Artifact

Open a task's workspace or a discussion's **Files & artifacts** area to find its linked deliverables. Archived artifacts are hidden from normal browsing.

Files shared in Discussions may also be promoted into tracked artifacts. When that happens, use the artifact viewer for version history and downloads instead of treating the discussion attachment as the canonical copy.

### Confirm detected task output

When an agent run detects a deliverable:

1. Open the Task and select **Work**.
2. Review the pending output's filename, path, source, and run.
3. Select **Create Artifact** when the Task has no linked artifact, or **Add
   Version** when the output belongs to the existing artifact.
4. Open the resulting artifact and confirm the version source, changelog, and
   content. Use **Dismiss** only when the detected file is not a deliverable.

Confirming a new output preserves the run provenance. Adding it to an existing
artifact advances that artifact without overwriting earlier versions.

## Add a Version

From a Task's **Work** tab:

1. Open the linked artifact and select **Add Version**.
2. Choose **Text** to paste content or **File** to supply a file URL.
3. Enter a changelog that explains the revision.
4. Select **Save Version**.
5. Confirm that the new version is current and the previous version remains in
   **Version History**.

When a Task is in review, the review action bar also provides **Add Version**
and opens the same form.

## Review History and Download

Open an artifact to inspect its metadata and current version. File-backed versions display a file chip you can use to download the original asset. The version list preserves earlier content, its source, publication detail, and changelog.

Review the current version first, then expand **Version History** when more than
five versions exist. Compare version number, source, changelog, and creation
time before approving the Task or sharing the deliverable. Download the
file-backed version when you need to verify the original asset.

## Archive and Restore

Founders can archive an active artifact from its artifact card. Archive when a
deliverable should no longer appear in normal browsing but its audit trail must
remain available:

1. Open the artifact card in its source Discussion.
2. Select **Archive** and confirm the status changes to `archived`.
3. To restore it, reopen the archived artifact card and select **Unarchive**.
4. Confirm the status returns to `active` and its complete version history is
   still present.

Archive and restore do not delete versions or their assets.

## Related Documentation

- [Artifacts API](../../api/artifacts.md)
- [Discussions](discussions.md)
- [Managing Tasks](managing-tasks.md)
