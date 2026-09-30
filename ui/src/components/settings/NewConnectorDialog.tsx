import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { mcpConnectorsApi, type CreateConnectorInput } from "@/api/mcpConnectors";
import { ApiError } from "@/api/client";
import { useToast } from "@/context/ToastContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogBody,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const SERVER_NAME_RE = /^[a-z0-9-]+$/;

const inputCls =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-brand/50";

interface NewConnectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  /** stdio is host-executing → only offered on a local_trusted host (D7). The
   *  parent already runs the health query that answers this, so it is passed
   *  in rather than re-fetched here. */
  stdioAllowed: boolean;
  /** Called after a successful create so the parent can invalidate/refetch
   *  the connectors list. */
  onSuccess: () => void;
}

/**
 * "Add a custom connector" — the BYO half of the connector journey (the
 * catalog/shelf half lives in Marketplace → Connectors). Extracted from the
 * always-visible inline form that used to live at the bottom of
 * MCPConnectorsSection into a modal, mirroring NewAoaAgentDialog's pattern:
 * controlled open/onOpenChange, a toast on success, and the dialog closing
 * itself once the mutation resolves.
 *
 * Field set, validation, and body-shape parsing are UNCHANGED from the
 * original inline form — only the chrome (modal vs. always-visible card) and
 * the post-success UX (toast instead of an inline persistent notice) moved.
 */
export function NewConnectorDialog({
  open,
  onOpenChange,
  companyId,
  stdioAllowed,
  onSuccess,
}: NewConnectorDialogProps) {
  const { pushToast } = useToast();

  const [displayName, setDisplayName] = useState("");
  const [serverName, setServerName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [secretRef, setSecretRef] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const serverNameValid = serverName === "" || SERVER_NAME_RE.test(serverName);

  function resetForm() {
    setDisplayName("");
    setServerName("");
    setTransport("http");
    setUrl("");
    setCommand("");
    setArgsText("");
    setSecretRef("");
    setHeadersText("");
    setFormError(null);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  }

  const createMutation = useMutation({
    mutationFn: (body: CreateConnectorInput) => mcpConnectorsApi.create(companyId, body),
    onSuccess: (created) => {
      setFormError(null);
      onSuccess();
      if (created.approvalId) {
        pushToast({
          title: "Connector added — pending approval",
          body: `"${created.displayName}" was created and is pending board approval before agents can use it.`,
          tone: "warn",
        });
      } else {
        pushToast({ title: "Connector added", tone: "success" });
      }
      handleOpenChange(false);
    },
    onError: (err) => {
      setFormError(err instanceof ApiError ? err.message : "Failed to create connector");
    },
  });

  const handleSubmit = () => {
    setFormError(null);
    if (!displayName.trim()) return setFormError("Display name is required.");
    if (!serverName.trim()) return setFormError("Server name is required.");
    if (!SERVER_NAME_RE.test(serverName))
      return setFormError(
        "Server name must match /^[a-z0-9-]+$/ (lowercase letters, digits, hyphen).",
      );
    // Early guard: a stdio connector in a non-local deployment is a guaranteed
    // 403 at the server (D7). Surface it inline instead of round-tripping.
    if (transport === "stdio" && !stdioAllowed)
      return setFormError(
        "Local (stdio) connectors run a command on the host and are only available in local deployments.",
      );
    if (transport === "http" && !url.trim()) return setFormError("HTTP transport requires a URL.");
    if (transport === "stdio" && !command.trim())
      return setFormError("stdio transport requires a command.");

    const args = argsText
      .split(/\s*\n\s*|\s+/)
      .map((a) => a.trim())
      .filter(Boolean);

    let headerTemplate: Record<string, string> | undefined;
    if (headersText.trim()) {
      const parsed: Record<string, string> = {};
      for (const line of headersText.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf(":");
        if (idx === -1) return setFormError(`Header line "${trimmed}" must be "Name: value".`);
        parsed[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
      headerTemplate = parsed;
    }

    const body: CreateConnectorInput = {
      displayName: displayName.trim(),
      serverName: serverName.trim(),
      transport,
      ...(transport === "http" ? { url: url.trim() } : { command: command.trim() }),
      ...(transport === "stdio" && args.length ? { args } : {}),
      ...(headerTemplate && transport === "http" ? { headerTemplate } : {}),
      ...(secretRef.trim() ? { secretRef: secretRef.trim() } : {}),
    };
    createMutation.mutate(body);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a custom connector</DialogTitle>
          <DialogDescription>
            Point AoA at your own MCP server (HTTP or local command). To install a ready-made
            connector, use Browse connectors.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4 pt-0">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <div className="text-xs text-muted-foreground">Display name</div>
              <input
                className={inputCls}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Notion Docs"
                autoFocus
              />
            </label>
            <label className="space-y-1">
              <div className="text-xs text-muted-foreground">Server name</div>
              <input
                className={inputCls}
                value={serverName}
                onChange={(e) => setServerName(e.target.value.trim())}
                placeholder="notion-docs"
                aria-invalid={!serverNameValid}
              />
              <div
                className={
                  serverNameValid
                    ? "text-[11px] text-muted-foreground"
                    : "text-[11px] text-destructive"
                }
              >
                Lowercase letters, digits, and hyphens only (/^[a-z0-9-]+$/).
              </div>
            </label>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <div className="text-xs text-muted-foreground">Transport</div>
              <select
                className={inputCls}
                value={transport}
                onChange={(e) => setTransport(e.target.value as "http" | "stdio")}
              >
                <option value="http">HTTP (remote server)</option>
                <option value="stdio" disabled={!stdioAllowed}>
                  stdio (local command){stdioAllowed ? "" : " — local deployments only"}
                </option>
              </select>
              {!stdioAllowed && (
                <div className="text-[11px] text-muted-foreground">
                  Local (stdio) connectors run a command on the host and are only available in
                  local deployments.
                </div>
              )}
            </label>

            {transport === "http" ? (
              <label className="space-y-1">
                <div className="text-xs text-muted-foreground">URL</div>
                <input
                  className={inputCls}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://mcp.example.com/sse"
                />
              </label>
            ) : (
              <label className="space-y-1">
                <div className="text-xs text-muted-foreground">Command</div>
                <input
                  className={inputCls}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx @example/mcp-server"
                />
              </label>
            )}
          </div>

          {transport === "stdio" && (
            <label className="space-y-1 block">
              <div className="text-xs text-muted-foreground">
                Arguments (whitespace or newline separated, optional)
              </div>
              <input
                className={inputCls}
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="--port 8080 --verbose"
              />
            </label>
          )}

          {transport === "http" && (
            <label className="space-y-1 block">
              <div className="text-xs text-muted-foreground">
                Headers (one per line, "Name: value", optional)
              </div>
              <textarea
                className={`${inputCls} min-h-[64px] font-mono`}
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                // ${TOKEN} is the ONLY placeholder buildConnectorSpecs
                // substitutes (services/mcp-connectors.ts). Naming any
                // other variable here ships that literal to the MCP
                // server, which then authenticates as no-one — and the
                // obvious founder workaround is pasting a real token.
                placeholder={"Authorization: Bearer ${TOKEN}"}
              />
            </label>
          )}

          <label className="space-y-1 block">
            <div className="text-xs text-muted-foreground">
              Secret reference (company secret name, optional)
            </div>
            <input
              className={inputCls}
              value={secretRef}
              onChange={(e) => setSecretRef(e.target.value)}
              placeholder="mcp:notion"
            />
            <div className="text-[11px] text-muted-foreground">
              Must reference an existing company secret. Header/arg values use the{" "}
              <code>{"${TOKEN}"}</code> placeholder, which resolves to it.
            </div>
          </label>

          {formError && <div className="text-sm text-destructive">{formError}</div>}
        </DialogBody>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={createMutation.isPending || !serverNameValid}
          >
            {createMutation.isPending ? "Adding..." : "Add connector"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
