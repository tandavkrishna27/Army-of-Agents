import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { LobbyShellMobileMenuButton } from "@/components/LobbyShell";
import { SettingsUnavailableState } from "@/components/settings/SettingsUnavailableState";
import { useSettingsSidebar } from "@/components/settings/useSettingsSidebar";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

export function InstanceAccessPage() {
  const { companies } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  // Access is a settings section — show the shared Settings sidebar (Access active)
  // inside the persistent LobbyLayout shell, so it doesn't read as a new page.
  const { pillItems, deploymentState, retryDeploymentStatus } = useSettingsSidebar("access");
  const activePillRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activePillRef.current?.scrollIntoView?.({
      inline: "center",
      block: "nearest",
    });
  }, []);
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());
  const [adminConfirmOpen, setAdminConfirmOpen] = useState(false);

  const usersQuery = useQuery({
    queryKey: queryKeys.access.adminUsers(search),
    queryFn: () => accessApi.searchAdminUsers(search),
    enabled: deploymentState === "available",
    retry: false,
  });

  const selectedUser = useMemo(
    () => usersQuery.data?.find((user) => user.id === selectedUserId) ?? null,
    [selectedUserId, usersQuery.data],
  );

  const userAccessQuery = useQuery({
    queryKey: queryKeys.access.userCompanyAccess(selectedUserId ?? ""),
    queryFn: () => accessApi.getUserCompanyAccess(selectedUserId!),
    enabled: deploymentState === "available" && !!selectedUserId,
    retry: false,
  });

  useEffect(() => {
    if (!selectedUserId && usersQuery.data?.[0]) {
      setSelectedUserId(usersQuery.data[0].id);
    }
  }, [selectedUserId, usersQuery.data]);

  useEffect(() => {
    if (!userAccessQuery.data) return;
    setSelectedCompanyIds(
      new Set(userAccessQuery.data.companyAccess.map((membership) => membership.companyId)),
    );
  }, [userAccessQuery.data]);

  const updateCompanyAccessMutation = useMutation({
    mutationFn: () => accessApi.setUserCompanyAccess(selectedUserId!, [...selectedCompanyIds]),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.access.userCompanyAccess(selectedUserId!),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.access.adminUsers(search),
      });
      pushToast({ title: "Company access updated", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to update company access.",
        tone: "error",
      });
    },
  });

  const setAdminMutation = useMutation({
    mutationFn: async (makeAdmin: boolean) => {
      if (!selectedUserId) throw new Error("No user selected");
      if (makeAdmin) return accessApi.promoteInstanceAdmin(selectedUserId);
      return accessApi.demoteInstanceAdmin(selectedUserId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.access.adminUsers(search),
      });
      if (selectedUserId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.access.userCompanyAccess(selectedUserId),
        });
      }
      pushToast({ title: "Instance role updated", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to update instance role.",
        tone: "error",
      });
    },
  });

  const isSelectedAdmin = selectedUser?.isInstanceAdmin ?? false;

  const handleAdminClick = () => {
    if (!selectedUserId) return;
    setAdminConfirmOpen(true);
  };

  const handleAdminConfirm = () => {
    setAdminConfirmOpen(false);
    setAdminMutation.mutate(!isSelectedAdmin);
  };

  if (deploymentState !== "available") {
    return (
      <div className="mx-auto w-full max-w-[1080px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
        <LobbyShellMobileMenuButton className="mb-4" />
        <div className="mb-5">
          <h1 className="text-[1.55rem] font-bold tracking-tight">
            Instance access<span className="text-brand">.</span>
          </h1>
        </div>
        <div className="md:hidden mb-5 relative">
          <div className="overflow-x-auto -mx-4 px-4 pb-1 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
            <div className="flex gap-1.5 w-max">
              {pillItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={item.onClick}
                  className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-3 py-2 text-[12.5px] font-medium text-foreground/[0.78] transition-colors hover:bg-card-2 hover:text-foreground"
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <SettingsUnavailableState
          sectionName="Access"
          deploymentState={deploymentState}
          onRetry={retryDeploymentStatus}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
      <LobbyShellMobileMenuButton className="mb-4" />

      <div className="mb-5">
        <h1 className="text-[1.55rem] font-bold tracking-tight">
          Instance access<span className="text-brand">.</span>
        </h1>
      </div>

      {/* Mobile-only section nav (desktop uses the LobbyShell secondary sidebar slot) */}
      <div className="md:hidden mb-5 relative">
        <div className="overflow-x-auto -mx-4 px-4 pb-1 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
          <div className="flex gap-1.5 w-max">
            {pillItems.map((item) => (
              <button
                key={item.id}
                ref={item.active ? activePillRef : undefined}
                type="button"
                data-active={item.active ? "true" : undefined}
                onClick={item.onClick}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-[12.5px] font-medium transition-colors border whitespace-nowrap shrink-0",
                  item.active
                    ? "bg-brand/[0.08] text-[hsl(15_60%_75%)] border-brand/[0.25]"
                    : "bg-card border-border text-foreground/[0.78] hover:bg-card-2 hover:text-foreground",
                )}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-bg to-transparent"
        />
      </div>

      <div className="space-y-6">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Search users, manage instance-admin status, and control which companies they can access.
        </p>

        {usersQuery.error ? (
          <div className="text-sm text-destructive">
            {usersQuery.error instanceof ApiError && usersQuery.error.status === 403
              ? "Instance admin access is required to manage users."
              : usersQuery.error instanceof Error
              ? usersQuery.error.message
              : "Failed to load users."}
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
            <section className="space-y-4 rounded-xl border border-border bg-card p-4">
              <label className="block space-y-2 text-sm">
                <span className="font-medium">Search users</span>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by name or email"
                />
              </label>
              <div className="space-y-2">
                {usersQuery.isLoading ? (
                  <div className="text-sm text-muted-foreground">Loading instance users…</div>
                ) : (usersQuery.data ?? []).length === 0 ? (
                  <div className="text-sm text-muted-foreground">No users match that search.</div>
                ) : (
                  (usersQuery.data ?? []).map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      onClick={() => setSelectedUserId(user.id)}
                      className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                        user.id === selectedUserId
                          ? "border-foreground bg-accent"
                          : "border-border hover:bg-accent/40"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {user.name || user.email || user.id}
                          </div>
                          <div className="truncate text-sm text-muted-foreground">
                            {user.email || user.id}
                          </div>
                        </div>
                        {user.isInstanceAdmin ? (
                          <ShieldCheck className="h-4 w-4 text-emerald-600" />
                        ) : null}
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        {user.activeCompanyMembershipCount} active company memberships
                      </div>
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="space-y-4 rounded-xl border border-border bg-card p-5">
              {!selectedUserId ? (
                <div className="text-sm text-muted-foreground">
                  Select a user to inspect instance access.
                </div>
              ) : userAccessQuery.isLoading ? (
                <div className="text-sm text-muted-foreground">Loading user access…</div>
              ) : userAccessQuery.error ? (
                <div className="text-sm text-destructive">
                  {userAccessQuery.error instanceof Error
                    ? userAccessQuery.error.message
                    : "Failed to load user access."}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="text-lg font-semibold">
                        {selectedUser?.name || selectedUser?.email || selectedUserId}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {selectedUser?.email || selectedUserId}
                      </div>
                    </div>
                    <Button
                      variant={isSelectedAdmin ? "outline" : "default"}
                      onClick={handleAdminClick}
                      disabled={setAdminMutation.isPending}
                    >
                      {isSelectedAdmin ? "Remove instance admin" : "Promote to instance admin"}
                    </Button>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <h2 className="text-sm font-semibold">Company access</h2>
                      <p className="text-sm text-muted-foreground">
                        Toggle company membership for this user. New access defaults to an active
                        member membership.
                      </p>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      {companies.map((company) => (
                        <label
                          key={company.id}
                          className="flex items-start gap-3 rounded-lg border border-border px-3 py-3"
                        >
                          <Checkbox
                            checked={selectedCompanyIds.has(company.id)}
                            onCheckedChange={(checked) => {
                              setSelectedCompanyIds((current) => {
                                const next = new Set(current);
                                if (checked) next.add(company.id);
                                else next.delete(company.id);
                                return next;
                              });
                            }}
                          />
                          <span className="space-y-1">
                            <span className="block text-sm font-medium">{company.name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {company.issuePrefix}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                    <div className="flex justify-end">
                      <Button
                        onClick={() => updateCompanyAccessMutation.mutate()}
                        disabled={updateCompanyAccessMutation.isPending}
                      >
                        {updateCompanyAccessMutation.isPending ? "Saving…" : "Save company access"}
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h2 className="text-sm font-semibold">Current memberships</h2>
                    <div className="space-y-2">
                      {(userAccessQuery.data?.companyAccess ?? []).length === 0 ? (
                        <div className="text-sm text-muted-foreground">
                          No active company memberships.
                        </div>
                      ) : (
                        (userAccessQuery.data?.companyAccess ?? []).map((membership) => (
                          <div
                            key={membership.id}
                            className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                          >
                            <div>
                              <div className="font-medium">
                                {membership.companyName || membership.companyId}
                              </div>
                              <div className="text-muted-foreground">
                                {membership.membershipRole || "unset"} • {membership.status}
                              </div>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {new Date(membership.updatedAt).toLocaleDateString()}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </>
              )}
            </section>
          </div>
        )}
      </div>

      <AlertDialog open={adminConfirmOpen} onOpenChange={setAdminConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isSelectedAdmin ? "Remove instance admin?" : "Promote to instance admin?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isSelectedAdmin
                ? `${
                    selectedUser?.name || selectedUser?.email || "This user"
                  } will lose instance-admin privileges and can no longer manage users or companies.`
                : `${
                    selectedUser?.name || selectedUser?.email || "This user"
                  } will gain instance-admin privileges and be able to manage every user and company in this instance.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleAdminConfirm}>
              {isSelectedAdmin ? "Remove admin" : "Promote"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
