import { useRef, useState } from "react";
import type { UniverseIntakeDestination, UniverseIntakeSnapshot } from "@armyofagents/shared";
import { universeIntakeApi } from "../../api/universe-intake";

const PART_BYTES = 4 * 1024 * 1024;

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export type ArtifactIntakePanelProps = {
  companyId: string;
  destination: UniverseIntakeDestination;
  onPublished?: (assetId: string) => void;
};

/** Browser File objects remain ephemeral. Only the server intake identity and
 * metadata are durable; after reload the user must explicitly reselect bytes. */
export function ArtifactIntakePanel({ companyId, destination, onPublished }: ArtifactIntakePanelProps) {
  const input = useRef<HTMLInputElement>(null);
  const [snapshot, setSnapshot] = useState<UniverseIntakeSnapshot | null>(null);
  const destinationLabel = destination.kind === "canvas" ? "Add to this canvas" : "Attach to message";
  const [status, setStatus] = useState(`Choose a file. ${destinationLabel}.`);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setStatus("Checking file…");
    try {
      const bytes = await file.arrayBuffer();
      const hash = await sha256(bytes);
      const recoveryKey = `aoa:universe-intake:${companyId}:${JSON.stringify(destination)}`;
      const saved = (() => {
        try { return JSON.parse(sessionStorage.getItem(recoveryKey) ?? "null") as { clientKey: string; intakeId?: string; name: string; size: number; hash: string } | null; }
        catch { return null; }
      })();
      const matches = saved?.name === file.name && saved.size === file.size && saved.hash === hash;
      const clientKey = matches ? saved.clientKey : crypto.randomUUID();
      const started = await universeIntakeApi.begin(companyId, {
        clientKey, destination, filename: file.name,
        contentType: file.type || "application/octet-stream", byteSize: file.size, sha256: hash,
      });
      sessionStorage.setItem(recoveryKey, JSON.stringify({ clientKey, intakeId: started.intakeId, name: file.name, size: file.size, hash }));
      setSnapshot(started);
      for (let offset = 0, index = 0; offset < bytes.byteLength; offset += PART_BYTES, index += 1) {
        if (started.receivedParts.includes(index)) continue;
        const part = bytes.slice(offset, Math.min(offset + PART_BYTES, bytes.byteLength));
        setStatus(`Uploading part ${index + 1} of ${Math.ceil(bytes.byteLength / PART_BYTES)}…`);
        setSnapshot(await universeIntakeApi.putPart(companyId, started.intakeId, index, part, await sha256(part)));
      }
      setStatus("Verifying original…");
      const published = await universeIntakeApi.finalize(companyId, started.intakeId);
      setSnapshot(published);
      setStatus("Original ready.");
      sessionStorage.removeItem(recoveryKey);
      if (published.assetId) onPublished?.(published.assetId);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upload failed. Reselect the file to retry.");
    } finally {
      setBusy(false);
    }
  }

  return <section aria-label="Add original">
    <input ref={input} type="file" hidden onChange={event => {
      const file = event.currentTarget.files?.[0];
      if (file) void upload(file);
      event.currentTarget.value = "";
    }}/>
    <button type="button" disabled={busy} onClick={() => input.current?.click()}>
      {snapshot && snapshot.state !== "published" ? "Reselect file" : destinationLabel}
    </button>
    {snapshot && snapshot.state !== "published" && <button type="button" disabled={busy} onClick={async () => {
      setSnapshot(await universeIntakeApi.cancel(companyId, snapshot.intakeId));
      setStatus("Upload cancelled.");
    }}>Cancel upload</button>}
    <p role="status" aria-live="polite">{status}</p>
  </section>;
}
