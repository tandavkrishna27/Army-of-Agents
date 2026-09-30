import { useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { memoryAssetsApi } from "../../api/memoryAssets";

export interface UploadedAsset {
  id: string;
  fileName: string;
}

export interface BraindumpDropZoneProps {
  companyId: string;
  /** Null for the company-wide card. */
  departmentId: string | null;
  /** Folder the file is filed under in the memory tree, e.g. "Company/Files". */
  folderPath: string;
  /** Accessible name — cards are repeated, so each zone needs its own. */
  label: string;
  assets: UploadedAsset[];
  onAssetsChange: (next: UploadedAsset[]) => void;
  /** Reported to the parent so Continue can't fire mid-upload and submit the
   *  card without the file the founder just dropped. */
  onUploadingChange?: (uploading: boolean) => void;
  disabled?: boolean;
}

/**
 * Item 5 / Phase 5d — file drop for one braindump scope.
 *
 * Files upload IMMEDIATELY on drop (to /memory/assets/upload), not on submit:
 * the braindump payload references `memory_assets.id`s, so the asset row has to
 * exist before Continue. That means an abandoned onboarding can leave orphan
 * assets — an acceptable trade (they're real files in the founder's own memory
 * tree, visible and deletable there) against making Continue a multi-megabyte
 * blocking upload.
 *
 * Each scope files into its own Files folder, which is why folderPath is a
 * prop rather than derived here.
 */
export function BraindumpDropZone({
  companyId,
  departmentId,
  folderPath,
  label,
  assets,
  onAssetsChange,
  onUploadingChange,
  disabled,
}: BraindumpDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // onAssetsChange fires once per file inside the upload loop; reading the
  // latest list from a ref stops each call from overwriting the previous
  // file's result with a stale snapshot of `assets`.
  const assetsRef = useRef(assets);
  assetsRef.current = assets;

  /** Overlapping upload batches still in flight. */
  const inFlightRef = useRef(0);

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    // Counted, not a boolean: two overlapping drops would otherwise have the
    // first batch to finish report "done" while the second is still uploading.
    inFlightRef.current += 1;
    onUploadingChange?.(true);
    setUploading((n) => n + files.length);
    // Sequential: the server takes one file per request, and a founder dropping
    // a folder of notes shouldn't fire 30 parallel multipart uploads.
    for (const file of files) {
      try {
        const { asset } = await memoryAssetsApi.upload(companyId, file, {
          ...(departmentId ? { departmentId } : {}),
          folderPath,
        });
        onAssetsChange([...assetsRef.current, { id: asset.id, fileName: asset.fileName }]);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Couldn't upload ${file.name}.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    inFlightRef.current -= 1;
    if (inFlightRef.current === 0) onUploadingChange?.(false);
  }

  // Unlinks the file from THIS braindump only. The asset stays in the memory
  // tree — the founder dropped it into their own Files folder, so silently
  // deleting it on an X-click would be destroying data they can still see.
  function removeAsset(id: string) {
    onAssetsChange(assets.filter((a) => a.id !== id));
  }

  return (
    <div className="mt-3">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-disabled={disabled || undefined}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragging(false);
          void uploadFiles(Array.from(e.dataTransfer.files));
        }}
        className={`flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-[11px] transition-colors ${
          dragging ? "border-accent text-text" : "border-border-strong text-dim"
        } ${disabled ? "pointer-events-none opacity-50" : ""}`}
      >
        <Paperclip className="h-3 w-3" aria-hidden />
        {uploading > 0 ? `Uploading ${uploading} file${uploading > 1 ? "s" : ""}…` : "Drop files or click to attach"}
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void uploadFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {assets.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1">
          {assets.map((asset) => (
            <li
              key={asset.id}
              className="flex items-center gap-1 rounded-full border border-border-strong px-2 py-1 text-[10px] text-dim"
            >
              <span className="max-w-[160px] truncate">{asset.fileName}</span>
              <button
                type="button"
                aria-label={`Remove ${asset.fileName}`}
                onClick={() => removeAsset(asset.id)}
                disabled={disabled}
                className="text-dim hover:text-text"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
