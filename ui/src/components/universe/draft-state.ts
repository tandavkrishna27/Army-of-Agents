// Pure client draft-state helpers for E1.3/2 (submission acknowledgement). No
// React or network here so it unit-tests directly. The server draft clear is a
// separate CAS patch issued only after a durable acknowledgement.

export interface Draft {
  revision: number;
  text: string;
  attachmentAssetIds: string[];
}

/** The immutable snapshot frozen at Send time, tagged with its idempotency key.
 * Later selection changes cannot retarget it. */
export interface SentSnapshot extends Draft {
  clientSubmissionId: string;
}

const sameAttachments = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * After a submission is durably acknowledged, clear the draft only if the local
 * draft still equals exactly what was sent (same revision, text and attachments).
 * If the user kept typing while the send was in flight, the newer draft is
 * retained untouched — we never clear text the user did not send.
 */
export function afterAcknowledgement(current: Draft, sent: SentSnapshot): Draft {
  const unchanged =
    current.revision === sent.revision &&
    current.text === sent.text &&
    sameAttachments(current.attachmentAssetIds, sent.attachmentAssetIds);
  return unchanged ? { ...current, text: "", attachmentAssetIds: [] } : current;
}
