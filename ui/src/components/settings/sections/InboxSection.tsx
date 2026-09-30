import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import type {
  HubAutopilotPolicy,
  HubPreferences,
  NotificationPreferences,
  UpdateHubAutopilotPolicyInput,
  UpdateHubPreferencesInput,
  UpdateNotificationPreferencesInput,
} from "@armyofagents/shared";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@armyofagents/shared";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { hubItemsApi } from "@/api/hub-items";
import { queryKeys } from "@/lib/queryKeys";
import { InboxSettingsPanel } from "@/components/inbox/InboxSettingsPanel";

const DEFAULT_PREFERENCES: HubPreferences = {
  defaultLanding: "home",
  visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
  groupMode: "auto",
  density: "comfortable",
  showAutopilotEntry: true,
  updatedAt: null,
};
const DEFAULT_AUTOPILOT_POLICY: HubAutopilotPolicy = {
  mode: "off",
  handledToday: 0,
  lastHandledAt: null,
  rules: [],
  updatedAt: null,
};

export function InboxSection() {
  const { selectedCompanyId } = useCompany();
  if (!selectedCompanyId) {
    return (
      <div className="p-8">
        <p className="text-sm text-muted-foreground">Select a company to manage Inbox settings.</p>
      </div>
    );
  }
  return <InboxSettingsSection key={selectedCompanyId} companyId={selectedCompanyId} />;
}

function InboxSettingsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  // Without an error surface a failed save silently snaps the control back and the
  // founder thinks it stuck. Route every mutation failure to a warn toast.
  const onError = () =>
    pushToast({ title: "Couldn't save Inbox settings. Try again.", tone: "warn" });
  // Autopilot/preference changes can alter what the hub shows (Drive auto-handles
  // items server-side), so refresh the hub list + counts after a settings change.
  const invalidateHub = () => {
    void queryClient.invalidateQueries({ queryKey: ["hub-items", companyId] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.hubItems.counts(companyId) });
  };

  const preferencesQuery = useQuery({
    queryKey: queryKeys.hubItems.preferences(companyId),
    queryFn: () => hubItemsApi.getPreferences(companyId),
  });
  const autopilotQuery = useQuery({
    queryKey: queryKeys.hubItems.autopilotPolicy(companyId),
    queryFn: () => hubItemsApi.autopilotPolicy.get(companyId),
  });
  const notificationQuery = useQuery({
    queryKey: queryKeys.notifications.preferences(companyId),
    queryFn: () => hubItemsApi.notificationPreferences.get(companyId),
  });
  const digestQuery = useQuery({
    queryKey: queryKeys.notifications.digest(companyId),
    queryFn: () => hubItemsApi.notificationDigest.list(companyId),
  });

  const setPrefs = (data: HubPreferences) =>
    queryClient.setQueryData(queryKeys.hubItems.preferences(companyId), data);
  const setPolicy = (data: HubAutopilotPolicy) =>
    queryClient.setQueryData(queryKeys.hubItems.autopilotPolicy(companyId), data);
  const setNotif = (data: NotificationPreferences) =>
    queryClient.setQueryData(queryKeys.notifications.preferences(companyId), data);

  const updatePreferences = useMutation({
    mutationFn: (patch: UpdateHubPreferencesInput) => hubItemsApi.updatePreferences(companyId, patch),
    onSuccess: setPrefs,
    onError,
  });
  const updateAutopilot = useMutation({
    mutationFn: (patch: UpdateHubAutopilotPolicyInput) =>
      hubItemsApi.autopilotPolicy.update(companyId, patch),
    onSuccess: (data) => {
      setPolicy(data);
      invalidateHub();
    },
    onError,
  });
  const resetAutopilot = useMutation({
    mutationFn: () => hubItemsApi.autopilotPolicy.reset(companyId),
    onSuccess: (data) => {
      setPolicy(data);
      invalidateHub();
    },
    onError,
  });
  const updateNotifications = useMutation({
    mutationFn: (patch: UpdateNotificationPreferencesInput) =>
      hubItemsApi.notificationPreferences.update(companyId, patch),
    onSuccess: setNotif,
    onError,
  });
  const resetNotifications = useMutation({
    mutationFn: () => hubItemsApi.notificationPreferences.reset(companyId),
    onSuccess: setNotif,
    onError,
  });
  const ackDigest = useMutation({
    mutationFn: () => hubItemsApi.notificationDigest.ack(companyId),
    onError,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.digest(companyId) }),
  });

  return (
    <div data-testid="inbox-section">
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Operations
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          Inbox<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Control how the Inbox behaves — its default view, visible lanes, grouping,
          density, Autopilot, and how notifications reach you.
        </p>
      </div>
      <div className="p-8 max-w-[680px]">
        <InboxSettingsPanel
          preferences={preferencesQuery.data ?? DEFAULT_PREFERENCES}
          preferencesPending={updatePreferences.isPending}
          onPreferencesChange={(patch) => updatePreferences.mutate(patch)}
          autopilotPolicy={autopilotQuery.data ?? DEFAULT_AUTOPILOT_POLICY}
          autopilotPending={updateAutopilot.isPending || resetAutopilot.isPending}
          onUpdateAutopilotPolicy={(patch) => updateAutopilot.mutate(patch)}
          onResetAutopilotPolicy={() => resetAutopilot.mutate()}
          notificationPreferences={notificationQuery.data ?? DEFAULT_NOTIFICATION_PREFERENCES}
          notificationPreferencesPending={
            updateNotifications.isPending || resetNotifications.isPending || ackDigest.isPending
          }
          onUpdateNotificationPreferences={(patch) => updateNotifications.mutate(patch)}
          onResetNotificationPreferences={() => resetNotifications.mutate()}
          digestItems={digestQuery.data?.items ?? []}
          onAckDigest={() => ackDigest.mutate()}
        />
      </div>
    </div>
  );
}
