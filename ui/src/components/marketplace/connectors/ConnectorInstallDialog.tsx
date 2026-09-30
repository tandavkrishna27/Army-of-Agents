import { useEffect, useState } from "react";
import { AlertTriangle, Terminal } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { McpConnectorShelfEntry } from "@/api/mcpConnectors";

/**
 * The argv line the founder is consenting to, rendered EXACTLY as the server
 * signed it: `command` followed by `args` in order, single-space joined.
 *
 * This is deliberately not prettified, wrapped, or truncated. The consent token
 * binds to `{ command, args }` verbatim, so anything the founder reads that is
 * not the literal argv is a lie about what will execute.
 */
export function commandLine(entry: { command?: string; args?: string[] }): string {
  return [entry.command ?? "", ...(entry.args ?? [])].join(" ").trim();
}

export interface ConnectorInstallDialogProps {
  /** `null` closes the dialog. Derived from live query data by the shelf, so a
   *  refetch re-renders this dialog with the refreshed token automatically. */
  entry: McpConnectorShelfEntry | null;
  onClose: () => void;
  onConfirm: (entry: McpConnectorShelfEntry) => void;
  busy: boolean;
  error: string | null;
}

/**
 * The consent dialog — shown ONLY for entries the server flagged
 * `consentRequired`, i.e. unverified stdio. Verified and http entries install
 * straight from the card with no interstitial, because there is no host command
 * to consent to and confirmation friction with nothing to confirm just trains
 * founders to click through.
 *
 * ⚠ This gate is a USABILITY layer. The server independently re-checks D7
 * authorization and re-verifies the consent token against its own catalog read;
 * nothing here is load-bearing for security, and nothing here may be relaxed on
 * the assumption that it is.
 */
export function ConnectorInstallDialog({
  entry,
  onClose,
  onConfirm,
  busy,
  error,
}: ConnectorInstallDialogProps) {
  const [confirmed, setConfirmed] = useState(false);

  // Reset the confirmation whenever the dialog targets a different entry, so a
  // tick on entry A can never carry over into entry B's install.
  useEffect(() => {
    setConfirmed(false);
  }, [entry?.id]);

  if (!entry) return null;

  const argv = commandLine(entry);
  // A missing token means the server could not mint one (no signing secret).
  // Installing anyway is a guaranteed 400, so say so rather than fail opaquely.
  const tokenMissing = !entry.consentToken;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Install {entry.displayName}</DialogTitle>
          <DialogDescription>
            This connector runs a command on this machine.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="rounded-md border border-warning/30 bg-warning/[0.06] px-3 py-2.5 text-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="size-4 shrink-0 mt-0.5 text-warning" />
              <div>
                <div className="font-medium">The publisher is unverified.</div>
                <div className="mt-0.5 text-dim">
                  Nobody has vouched for this entry. AoA will start the process below with
                  your own account's privileges, and it can download and run code as it
                  starts.
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wide">
              <Terminal className="size-3.5" />
              Command that will run
            </div>
            <pre
              data-testid="connector-consent-command"
              className="rounded-md border border-border bg-card-2 px-3 py-2 text-[12.5px] font-mono whitespace-pre-wrap break-all"
            >
              {argv}
            </pre>
          </div>

          {entry.requiresSecret && (
            <div className="text-[12.5px] text-dim">
              After installing you'll need to bind a credential
              {entry.secretLabel ? ` (${entry.secretLabel})` : ""} before agents can use
              this connector.
            </div>
          )}

          <label className="flex items-start gap-2.5 text-sm cursor-pointer">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(v) => setConfirmed(v === true)}
              className="mt-0.5"
            />
            <span>
              I understand this will run <code className="font-mono">{argv}</code> on this
              machine, and I trust this publisher.
            </span>
          </label>

          {tokenMissing && (
            <div className="text-sm text-destructive">
              This deployment could not issue a consent token for this entry, so it cannot
              be installed from the shelf.
            </div>
          )}
          {error && <div className="text-sm text-destructive">{error}</div>}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onConfirm(entry)}
            disabled={!confirmed || busy || tokenMissing}
          >
            {busy ? "Installing..." : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
