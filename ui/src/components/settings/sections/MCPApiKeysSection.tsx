import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { mcpApi } from "@/api/mcp";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Puzzle } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ToggleField } from "@/components/agent-config-primitives";

export function MCPApiKeysSection() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [newKeyName, setNewKeyName] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const { data: status } = useQuery({
    queryKey: queryKeys.mcp.status(selectedCompanyId!),
    queryFn: () => mcpApi.status(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: keys } = useQuery({
    queryKey: queryKeys.mcp.keys(selectedCompanyId!),
    queryFn: () => mcpApi.listKeys(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: clients } = useQuery({
    queryKey: queryKeys.mcp.clients(selectedCompanyId!),
    queryFn: () => mcpApi.listClients(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const updateSettingsMutation = useMutation({
    mutationFn: (enabled: boolean) => mcpApi.updateSettings(selectedCompanyId!, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.status(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.detail(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  const createKeyMutation = useMutation({
    mutationFn: (name: string) => mcpApi.createKey(selectedCompanyId!, name),
    onSuccess: (created) => {
      setNewKeyName("");
      setRevealedToken(created.token);
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.keys(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.status(selectedCompanyId!) });
    },
  });

  const revokeKeyMutation = useMutation({
    mutationFn: (keyId: string) => mcpApi.revokeKey(selectedCompanyId!, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.keys(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.status(selectedCompanyId!) });
    },
  });

  const enabled = status?.enabled ?? false;
  const endpointPath = status?.endpointPath ?? `/api/companies/${selectedCompanyId}/mcp`;

  return (
    <div>
      {/* Section header */}
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Operations
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          MCP API keys<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Inbound JSON-RPC endpoint and API keys. Outbound integrations live elsewhere.
        </p>
      </div>

      <div className="p-8">
        {!selectedCompanyId ? (
          <EmptyState icon={Puzzle} message="Select a company to configure integrations." />
        ) : (
          <div className="space-y-6">
            <div className="space-y-4">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                MCP Server
              </div>
              <div className="rounded-md border border-border px-4 py-4 space-y-4">
                <ToggleField
                  label="Enable MCP server"
                  hint="Allow external MCP clients to read scoped resources and use approved write tools."
                  checked={enabled}
                  onChange={(value) => updateSettingsMutation.mutate(value)}
                />
                <div className="grid gap-3 md:grid-cols-3">
                  <Card>
                    <CardContent className="p-4">
                      <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                        Status
                      </div>
                      <div className="text-sm font-medium">
                        {enabled ? "Enabled" : "Disabled"}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                        API Keys
                      </div>
                      <div className="text-sm font-medium">{status?.keyCount ?? 0}</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                        Connected Clients
                      </div>
                      <div className="text-sm font-medium">
                        {status?.connectedClients ?? 0}
                      </div>
                    </CardContent>
                  </Card>
                </div>
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">
                    Endpoint
                  </div>
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm font-mono break-all">
                    {window.location.origin}
                    {endpointPath}
                  </div>
                </div>
                {revealedToken && (
                  <div className="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-3">
                    <div className="text-sm font-medium">New API key</div>
                    <div className="rounded-md border border-border bg-background px-3 py-2 font-mono text-xs break-all">
                      {revealedToken}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      This token is only shown once.
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-4">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                API Key Management
              </div>
              <div className="rounded-md border border-border px-4 py-4 space-y-4">
                <div className="flex flex-col gap-3 md:flex-row">
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="Key name"
                  />
                  <Button
                    size="sm"
                    onClick={() => createKeyMutation.mutate(newKeyName.trim())}
                    disabled={!newKeyName.trim() || createKeyMutation.isPending}
                  >
                    {createKeyMutation.isPending ? "Creating..." : "Create key"}
                  </Button>
                </div>
                {createKeyMutation.isError && (
                  <div className="text-sm text-destructive">
                    {createKeyMutation.error instanceof Error
                      ? createKeyMutation.error.message
                      : "Failed to create key"}
                  </div>
                )}
                {(keys ?? []).length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No MCP API keys created yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(keys ?? []).map((key) => (
                      <div
                        key={key.id}
                        className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-3"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{key.name}</div>
                          <div className="text-xs text-muted-foreground">
                            Created {new Date(key.createdAt).toLocaleString()}
                            {key.lastUsedAt
                              ? ` • Last used ${new Date(key.lastUsedAt).toLocaleString()}`
                              : " • Never used"}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => revokeKeyMutation.mutate(key.id)}
                          disabled={revokeKeyMutation.isPending || !!key.revokedAt}
                        >
                          {key.revokedAt ? "Revoked" : "Revoke"}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-4">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Connected MCP Clients
              </div>
              <div className="rounded-md border border-border px-4 py-4 space-y-2">
                {(clients ?? []).length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No MCP clients have connected yet.
                  </div>
                ) : (
                  (clients ?? []).map((client) => (
                    <div
                      key={client.id}
                      className="rounded-md border border-border px-3 py-3"
                    >
                      <div className="text-sm font-medium">
                        {client.clientName ?? "Unknown client"}
                        {client.clientVersion ? ` ${client.clientVersion}` : ""}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Last seen {new Date(client.lastSeenAt).toLocaleString()}
                        {client.lastMethod ? ` • ${client.lastMethod}` : ""}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
