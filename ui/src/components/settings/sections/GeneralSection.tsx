import { useEffect, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { useTheme } from "@/context/ThemeContext";
import { companiesApi } from "@/api/companies";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Check, ChevronRight, Laptop, Moon, Sun, Upload, X } from "lucide-react";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { Field, ToggleField, HintIcon } from "@/components/agent-config-primitives";

// ─── Agent snippet helpers (copied from old SettingsPage) ────────────
type AgentSnippetInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

function buildCandidateOnboardingUrls(input: AgentSnippetInput): string[] {
  const candidates = (input.connectionCandidates ?? [])
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const urls = new Set<string>();
  let onboardingUrl: URL | null = null;

  try {
    onboardingUrl = new URL(input.onboardingTextUrl);
    urls.add(onboardingUrl.toString());
  } catch {
    const trimmed = input.onboardingTextUrl.trim();
    if (trimmed) {
      urls.add(trimmed);
    }
  }

  if (!onboardingUrl) {
    for (const candidate of candidates) {
      urls.add(candidate);
    }
    return Array.from(urls);
  }

  const onboardingPath = `${onboardingUrl.pathname}${onboardingUrl.search}`;
  for (const candidate of candidates) {
    try {
      const base = new URL(candidate);
      urls.add(`${base.origin}${onboardingPath}`);
    } catch {
      urls.add(candidate);
    }
  }

  return Array.from(urls);
}

function buildResolutionTestUrl(input: AgentSnippetInput): string | null {
  const explicit = input.testResolutionUrl?.trim();
  if (explicit) return explicit;

  try {
    const onboardingUrl = new URL(input.onboardingTextUrl);
    const testPath = onboardingUrl.pathname.replace(
      /\/onboarding\.txt$/,
      "/test-resolution"
    );
    return `${onboardingUrl.origin}${testPath}`;
  } catch {
    return null;
  }
}

function buildAgentSnippet(input: AgentSnippetInput) {
  const candidateUrls = buildCandidateOnboardingUrls(input);
  const resolutionTestUrl = buildResolutionTestUrl(input);

  const candidateList =
    candidateUrls.length > 0
      ? candidateUrls.map((u) => `- ${u}`).join("\n")
      : "- (No candidate URLs available yet.)";

  const connectivityBlock =
    candidateUrls.length === 0
      ? `No candidate URLs are available. Ask your user to configure a reachable hostname in AoA, then retry.
Suggested steps:
- choose a hostname that resolves to the AoA host from your runtime
- run: pnpm aoa allowed-hostname <host>
- restart AoA
- verify with: curl -fsS http://<host>:3100/api/health
- regenerate this invite snippet`
      : `If none are reachable, ask your user to add a reachable hostname in AoA, restart, and retry.
Suggested command:
- pnpm aoa allowed-hostname <host>
Then verify with: curl -fsS <base-url>/api/health`;

  const resolutionLine = resolutionTestUrl
    ? `\nYou MUST test callback reachability, call: ${resolutionTestUrl}?url=<urlencoded-webhook-url> (well using the hostname that worked above). Do not assume your 172.x is necessarily reachable from AoA. Test it. `
    : "";

  return `You're invited to join an AoA organization.

The URLs you should try are:
${candidateList}

Connectivity guidance:
If you are running on a different machine than AoA, AoA must be reachable at one of the hostnames used above.
Verify the hostname works from your runtime with: GET <base-url>/api/health

${connectivityBlock}

For your "agentName", just use your own agent name (OpenClaw or whatever your name is) and send it directly.
You also need to send a webhook URL that AoA can access. Check your config and include that URL.${resolutionLine}

---

In order for AoA to work smoothly, you need to enable \`gateway.http.endpoints.responses.enabled=true\` in your OpenClaw config.

Please enable that setting and notify your user that we did so.

Before you do anything, please respond to your user that you understand the instructions and you're going to work on them. Then do the step above in another session called "aoa-onboarding" and then tell your user when you're done. Update your user in intermediate steps along the way so they know what's going on.

Then after you've connected to AoA (exchanged keys etc.) you MUST review and follow the onboarding instructions in onboarding.txt they give you.

`;
}

export function GeneralSection() {
  const { selectedCompany, selectedCompanyId, companies, loading: companiesLoading } = useCompany();
  const { preference, setPreference } = useTheme();
  const queryClient = useQueryClient();

  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [rootFolder, setRootFolder] = useState("");
  const [humanQuestionSlaHours, setHumanQuestionSlaHours] = useState(24);

  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setRootFolder(selectedCompany.rootFolder ?? "");
    setHumanQuestionSlaHours(selectedCompany.humanQuestionSlaHours ?? 24);
  }, [selectedCompany]);

  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSnippet, setInviteSnippet] = useState<string | null>(null);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [snippetCopyDelightId, setSnippetCopyDelightId] = useState(0);

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? ""));

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  const logoInputRef = useRef<HTMLInputElement>(null);
  const logoUploadMutation = useMutation({
    mutationFn: (file: File) => companiesApi.uploadLogo(selectedCompanyId!, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.detail(selectedCompanyId!) });
    },
  });
  const logoRemoveMutation = useMutation({
    mutationFn: () => companiesApi.removeLogo(selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.detail(selectedCompanyId!) });
    },
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  const questionSlaMutation = useMutation({
    mutationFn: (hours: number) =>
      companiesApi.update(selectedCompanyId!, { humanQuestionSlaHours: hours }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.detail(selectedCompanyId!) });
    },
  });

  const rootFolderDirty = rootFolder !== (selectedCompany?.rootFolder ?? "");
  const rootFolderMutation = useMutation({
    mutationFn: (val: string | null) =>
      companiesApi.update(selectedCompanyId!, { rootFolder: val }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.detail(selectedCompanyId!) });
    },
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "agent",
      }),
    onSuccess: async (invite) => {
      setInviteError(null);
      const base = window.location.origin.replace(/\/+$/, "");
      const onboardingTextLink =
        invite.onboardingTextUrl ??
        invite.onboardingTextPath ??
        `/api/invites/${invite.token}/onboarding.txt`;
      const absoluteUrl = onboardingTextLink.startsWith("http")
        ? onboardingTextLink
        : `${base}${onboardingTextLink}`;
      setSnippetCopied(false);
      setSnippetCopyDelightId(0);
      let snippet: string;
      try {
        const manifest = await accessApi.getInviteOnboarding(invite.token);
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates:
            manifest.onboarding.connectivity?.connectionCandidates ?? null,
          testResolutionUrl:
            manifest.onboarding.connectivity?.testResolutionEndpoint?.url ??
            null,
        });
      } catch {
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates: null,
          testResolutionUrl: null,
        });
      }
      setInviteSnippet(snippet);
      try {
        await navigator.clipboard.writeText(snippet);
        setSnippetCopied(true);
        setSnippetCopyDelightId((prev) => prev + 1);
        setTimeout(() => setSnippetCopied(false), 2000);
      } catch {
        /* clipboard may not be available */
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(selectedCompanyId!),
      });
    },
    onError: (err) => {
      setInviteError(
        err instanceof Error ? err.message : "Failed to create invite"
      );
    },
  });

  useEffect(() => {
    setInviteError(null);
    setInviteSnippet(null);
    setSnippetCopied(false);
    setSnippetCopyDelightId(0);
  }, [selectedCompanyId]);

  if (!selectedCompany) {
    // N2: only show the dead-end copy when there is genuinely no company.
    // While companies are loading — or loaded but bootstrap selection hasn't
    // resolved yet (it lands in a post-render effect) — show a quiet loading
    // state instead of flashing "No company selected" at users who have one.
    if (companiesLoading || companies.length > 0) {
      return (
        <div className="p-8 text-sm text-muted-foreground" aria-busy="true">
          Loading company settings...
        </div>
      );
    }
    return (
      <div className="p-8 text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null,
    });
  }

  return (
    <div>
      {/* Section header */}
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Company
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          General<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">Identity and presentation for this company.</p>
      </div>

      <div className="p-8 space-y-6">
        {/* General */}
        <div className="space-y-4">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            General
          </div>
          <div className="space-y-3 rounded-md border border-border px-4 py-4">
            <Field label="Company name" hint="The display name for your company.">
              <input
                aria-label="Company name"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
            </Field>
            <Field
              label="Description"
              hint="Optional description shown in the company profile."
            >
              <input
                aria-label="Description"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                type="text"
                value={description}
                placeholder="Optional company description"
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </div>
        </div>

        {/* Appearance */}
        <div className="space-y-4">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Appearance
          </div>
          <div className="space-y-3 rounded-md border border-border px-4 py-4">
            {/* Logo */}
            <Field label="Company logo" hint="Displayed in sidebar and lobby. Recommended: square image, at least 128x128.">
              <div className="flex items-center gap-3">
                {selectedCompany.logoAssetId ? (
                  <img
                    src={`/api/assets/${selectedCompany.logoAssetId}/content`}
                    alt={selectedCompany.name}
                    className="w-16 h-16 rounded-lg object-cover border border-border"
                  />
                ) : (
                  <CompanyPatternIcon
                    companyName={companyName || selectedCompany.name}
                    brandColor={brandColor || null}
                    className="rounded-lg"
                  />
                )}
                <div className="flex flex-col gap-1.5">
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) logoUploadMutation.mutate(file);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => logoInputRef.current?.click()}
                    disabled={logoUploadMutation.isPending}
                  >
                    <Upload className="h-3.5 w-3.5 mr-1.5" />
                    {logoUploadMutation.isPending ? "Uploading..." : "Upload logo"}
                  </Button>
                  {selectedCompany.logoAssetId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs text-muted-foreground"
                      onClick={() => logoRemoveMutation.mutate()}
                      disabled={logoRemoveMutation.isPending}
                    >
                      <X className="h-3 w-3 mr-1" />
                      Remove
                    </Button>
                  )}
                  {logoUploadMutation.isError && (
                    <span className="text-xs text-destructive">
                      {logoUploadMutation.error instanceof Error
                        ? logoUploadMutation.error.message
                        : "Upload failed"}
                    </span>
                  )}
                </div>
              </div>
            </Field>

            {/* Brand color + icon preview */}
            <div className="flex items-start gap-4">
              <div className="shrink-0">
                <CompanyPatternIcon
                  companyName={companyName || selectedCompany.name}
                  brandColor={brandColor || null}
                  className="rounded-[14px]"
                />
              </div>
              <div className="flex-1 space-y-2">
                <Field
                  label="Brand color"
                  hint="Sets the hue for the company icon. Leave empty for auto-generated color."
                >
                  <div className="flex items-center gap-2">
                    <input
                      aria-label="Brand color picker"
                      type="color"
                      value={brandColor || "#6366f1"}
                      onChange={(e) => setBrandColor(e.target.value)}
                      className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                    />
                    <input
                      aria-label="Brand color hex"
                      type="text"
                      value={brandColor}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                          setBrandColor(v);
                        }
                      }}
                      placeholder="Auto"
                      className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                    />
                    {brandColor && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setBrandColor("")}
                        className="text-xs text-muted-foreground"
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                </Field>
              </div>
            </div>

            {/* Theme — Phase G migration from header */}
            <div className="border-t border-border pt-3">
              <div className="text-sm font-medium">Theme</div>
              <p className="text-[11.5px] text-muted-foreground mt-0.5">
                UI color scheme. "System" follows your OS preference.
              </p>
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                {(
                  [
                    { value: "dark", label: "Dark", icon: Moon },
                    { value: "light", label: "Light", icon: Sun },
                    { value: "system", label: "System", icon: Laptop },
                  ] as const
                ).map(({ value, label, icon: Icon }) => {
                  const active = preference === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setPreference(value)}
                      aria-pressed={active}
                      className={cn(
                        "px-3 py-1.5 text-sm rounded-md border inline-flex items-center gap-1.5 transition-colors",
                        active
                          ? "bg-card-3 border-border text-foreground"
                          : "border-border-strong text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3.5" />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Save button for General + Appearance */}
        {generalDirty && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSaveGeneral}
              disabled={generalMutation.isPending || !companyName.trim()}
            >
              {generalMutation.isPending ? "Saving..." : "Save changes"}
            </Button>
            {generalMutation.isSuccess && (
              <span className="text-xs text-muted-foreground">Saved</span>
            )}
            {generalMutation.isError && (
              <span className="text-xs text-destructive">
                {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : "Failed to save"}
              </span>
            )}
          </div>
        )}

        {/* Task execution */}
        <div className="space-y-4">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Task execution
          </div>
          <div className="space-y-3 rounded-md border border-border px-4 py-4">
            <Field
              label="Human question response time"
              hint="Elapsed time before an unanswered agent question is marked At risk. This does not reassign the question or restart work."
            >
              <div className="flex items-center gap-2">
                <input
                  aria-label="Human question response time"
                  type="number"
                  min={1}
                  max={24 * 30}
                  value={humanQuestionSlaHours}
                  onChange={(event) => setHumanQuestionSlaHours(Number(event.target.value))}
                  className="w-24 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                />
                <span className="text-sm text-muted-foreground">elapsed hours</span>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    questionSlaMutation.isPending
                    || !Number.isInteger(humanQuestionSlaHours)
                    || humanQuestionSlaHours < 1
                    || humanQuestionSlaHours > 24 * 30
                    || humanQuestionSlaHours === (selectedCompany.humanQuestionSlaHours ?? 24)
                  }
                  onClick={() => questionSlaMutation.mutate(humanQuestionSlaHours)}
                >
                  {questionSlaMutation.isPending ? "Saving..." : "Save"}
                </Button>
              </div>
            </Field>
            <p className="text-xs text-muted-foreground">
              Default: 24 elapsed hours. Departments and projects can override this for new questions.
            </p>
            {questionSlaMutation.isError ? (
              <p role="alert" className="text-xs text-destructive">Could not save the response-time policy.</p>
            ) : null}
          </div>
        </div>

        {/* Hiring */}
        <div className="space-y-4">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Hiring
          </div>
          <div className="rounded-md border border-border px-4 py-3">
            <ToggleField
              label="Require board approval for new hires"
              hint="New agent hires stay pending until approved by board."
              checked={!!selectedCompany.requireBoardApprovalForNewAgents}
              onChange={(v) => settingsMutation.mutate(v)}
            />
          </div>
        </div>

        {/* Invites */}
        <div className="space-y-4">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Invites
          </div>
          <div className="space-y-3 rounded-md border border-border px-4 py-4">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                Generate an agent snippet for join flows.
              </span>
              <HintIcon text="Creates an agent-only invite (10m) and renders a copy-ready snippet." />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => inviteMutation.mutate()}
                disabled={inviteMutation.isPending}
              >
                {inviteMutation.isPending
                  ? "Generating..."
                  : "Generate agent snippet"}
              </Button>
            </div>
            {inviteError && (
              <p className="text-sm text-destructive">{inviteError}</p>
            )}
            {inviteSnippet && (
              <div className="rounded-md border border-border bg-muted/30 p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">
                    Agent Snippet
                  </div>
                  {snippetCopied && (
                    <span
                      key={snippetCopyDelightId}
                      className="flex items-center gap-1 text-xs text-green-600 animate-pulse"
                    >
                      <Check className="h-3 w-3" />
                      Copied
                    </span>
                  )}
                </div>
                <div className="mt-1 space-y-1.5">
                  <textarea
                    className="h-[28rem] w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none"
                    value={inviteSnippet}
                    readOnly
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(inviteSnippet);
                          setSnippetCopied(true);
                          setSnippetCopyDelightId((prev) => prev + 1);
                          setTimeout(() => setSnippetCopied(false), 2000);
                        } catch {
                          /* clipboard may not be available */
                        }
                      }}
                    >
                      {snippetCopied ? "Copied snippet" : "Copy snippet"}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Company Data */}
        <div className="space-y-3">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Company Data
          </div>
          <Link
            to="/export"
            className="flex items-center justify-between rounded-md border border-border p-3 hover:bg-muted/50 transition-colors"
          >
            <div>
              <p className="text-sm font-medium">Export Company</p>
              <p className="text-xs text-muted-foreground">
                Package this company into a portable bundle.
              </p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Link>
        </div>

        {/* Workspace Root Folder (ghost setting -> UI) */}
        <div className="space-y-4">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Workspace Root Folder
          </div>
          <div className="space-y-3 rounded-md border border-border px-4 py-4">
            <div>
              <label htmlFor="root-folder-input" className="text-sm font-medium">Root folder</label>
              <p className="text-xs text-muted-foreground mt-1">
                Filesystem path where this company's execution workspaces are created.
                <span className="text-amber-500/80">
                  {" "}Changing this breaks paths for existing workspaces — only change if you know what you're doing.
                </span>
              </p>
            </div>
            <input
              id="root-folder-input"
              type="text"
              aria-label="Root folder"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              value={rootFolder}
              onChange={(e) => setRootFolder(e.target.value)}
            />
            {rootFolderDirty && (
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRootFolder(selectedCompany.rootFolder ?? "")}
                  className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => rootFolderMutation.mutate(rootFolder || null)}
                  disabled={rootFolderMutation.isPending}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {rootFolderMutation.isPending ? "Saving..." : "Save"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
