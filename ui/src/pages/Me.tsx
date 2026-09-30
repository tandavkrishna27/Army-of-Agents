import { useEffect, useState } from "react";
import { useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Settings } from "lucide-react";
import type { UpdateCurrentUserProfile } from "@armyofagents/shared";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { profileApi } from "../api/profile";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { ApiError } from "../api/client";
import { cn } from "../lib/utils";

function deriveInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

export function Me() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const profileQuery = useQuery({
    queryKey: queryKeys.auth.profile,
    queryFn: () => profileApi.get(),
  });

  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [avatarUrlDraft, setAvatarUrlDraft] = useState("");
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    if (profileQuery.data) {
      setDisplayNameDraft(profileQuery.data.displayName ?? "");
      setAvatarUrlDraft(profileQuery.data.avatarUrl ?? "");
      // Synthetic "Local Board" profile has a null email and cannot be edited
      // (PATCH /auth/profile returns 401 for local_implicit actors).
      if (profileQuery.data.email === null) setReadOnly(true);
    }
  }, [profileQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (patch: UpdateCurrentUserProfile) => profileApi.update(patch),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.auth.profile, data);
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      pushToast({ title: "Profile saved", tone: "success" });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) {
        setReadOnly(true);
        pushToast({
          title: "Profile is read-only",
          body: "This instance runs without user accounts, so the profile cannot be edited.",
          tone: "warn",
        });
        return;
      }
      pushToast({
        title: "Save failed",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const profile = profileQuery.data;
  const displayName = displayNameDraft || profile?.displayName || profile?.email || "Account";
  const initials = deriveInitials(displayName);
  const normalizedAvatar = avatarUrlDraft.trim();
  const normalizedName = displayNameDraft.trim();
  const hasChanges = Boolean(
    profile &&
      (normalizedName !== (profile.displayName ?? "") ||
        normalizedAvatar !== (profile.avatarUrl ?? "")),
  );
  const canSave = hasChanges && !readOnly && !saveMutation.isPending && normalizedName.length > 0;

  const handleSave = () => {
    if (!profile) return;
    const patch: UpdateCurrentUserProfile = {};
    if (normalizedName !== (profile.displayName ?? "")) patch.displayName = normalizedName;
    if (normalizedAvatar !== (profile.avatarUrl ?? "")) patch.avatarUrl = normalizedAvatar || null;
    saveMutation.mutate(patch);
  };

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {/* Minimal header — mirrors Lobby's chrome so /me feels like an instance-level page. */}
      <header className="flex items-center justify-between px-6 h-14 shrink-0 border-b border-border">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className={cn(
            "flex items-center gap-1.5 text-sm text-muted-foreground",
            "hover:text-foreground transition-colors",
          )}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        {/* N2: /instance/settings is instance-admin-only — hide the gear for
            everyone else (default hidden while the profile loads, same as the
            Lobby sidebar row). */}
        {profileQuery.data?.canManageInstanceSettings === true && (
          <button
            type="button"
            onClick={() => navigate("/instance/settings")}
            className={cn(
              "flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground",
              "hover:bg-accent hover:text-foreground transition-colors",
            )}
            aria-label="Instance settings"
          >
            <Settings className="h-4 w-4" />
          </button>
        )}
      </header>

      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-xl px-6 py-10 space-y-8">
          <div>
            <h1 className="text-xl font-bold">Your profile</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              How you appear across AoA companies.
            </p>
          </div>

          {profileQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : !profile ? (
            <p className="text-sm text-destructive">Failed to load profile.</p>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center gap-4">
                <Avatar size="lg" className="h-16 w-16">
                  {normalizedAvatar ? (
                    <AvatarImage src={normalizedAvatar} alt={displayName} />
                  ) : null}
                  <AvatarFallback className="text-lg">{initials}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="text-base font-semibold truncate">{displayName}</p>
                  <p className="text-sm text-muted-foreground truncate">
                    {profile.email ?? "No email on file"}
                  </p>
                </div>
              </div>

              {readOnly && (
                <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                  This profile is read-only because the server is running without user accounts.
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="me-display-name">Display name</Label>
                <Input
                  id="me-display-name"
                  value={displayNameDraft}
                  onChange={(e) => setDisplayNameDraft(e.target.value)}
                  disabled={readOnly || saveMutation.isPending}
                  maxLength={200}
                  placeholder="Your name"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="me-email">Email</Label>
                <Input id="me-email" value={profile.email ?? ""} readOnly disabled />
                <p className="text-xs text-muted-foreground">
                  Email cannot be changed from this screen.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="me-avatar-url">Avatar URL</Label>
                <Input
                  id="me-avatar-url"
                  type="url"
                  value={avatarUrlDraft}
                  onChange={(e) => setAvatarUrlDraft(e.target.value)}
                  disabled={readOnly || saveMutation.isPending}
                  maxLength={2048}
                  placeholder="https://example.com/avatar.png"
                />
                <p className="text-xs text-muted-foreground">
                  Paste a URL to an image. File upload is on the roadmap.
                </p>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <Button onClick={handleSave} disabled={!canSave}>
                  {saveMutation.isPending ? "Saving..." : "Save changes"}
                </Button>
                {hasChanges && !readOnly && !saveMutation.isPending && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDisplayNameDraft(profile.displayName ?? "");
                      setAvatarUrlDraft(profile.avatarUrl ?? "");
                    }}
                  >
                    Reset
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
