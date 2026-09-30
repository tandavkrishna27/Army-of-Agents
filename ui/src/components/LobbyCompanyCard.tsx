import { Bell } from "lucide-react";
import { CompanyPatternIcon } from "./CompanyPatternIcon";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { CompanyStats } from "@/api/companies";
import type { Company } from "@armyofagents/shared";

interface LobbyCompanyCardProps {
  company: Company;
  stats?: CompanyStats[string];
  statsLoading?: boolean;
  onClick: () => void;
}

/**
 * Single unified card design for the lobby.
 *
 * Layout (top → bottom):
 *  - Identity row: 56px squircle logo + name + sub-line (mono prefix · X agents) + pills (top-right, reserved 22px even when empty)
 *  - Stats row: 3 cells — Active tasks · Pending approvals · Tasks today
 *  - Activity section: up to 3 recent events (currently a placeholder until backend supplies recentActivity)
 *
 * Pills are conditional but their container always reserves space so the
 * layout never jumps when pills appear/disappear:
 *  - `live` (brand-red, pulsing): currently-running agents — backend signal TBD
 *  - `N pending` (warn): pendingApprovalCount > 0
 *  - `N unread` (default): unreadNotificationCount > 0
 *  - `N failed` (error): failed tasks in last 24h — backend signal TBD
 *
 * No top color stripe per locked design. Whole card is the click target.
 */
export function LobbyCompanyCard({ company, stats, statsLoading, onClick }: LobbyCompanyCardProps) {
  const pendingCount = stats?.pendingApprovalCount ?? 0;
  const unreadCount = stats?.unreadNotificationCount ?? 0;
  const showPending = pendingCount > 0;
  const showUnread = unreadCount > 0;
  // Live + failed signals not yet exposed by stats; render conditional space-holders
  // so the design hooks are in place when the backend lands those fields.
  const showLive = false;
  const failedCount = 0;
  const showFailed = failedCount > 0;
  const tasksTodayCount: number | undefined = undefined; // backend TBD

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative w-full rounded-[14px] border border-border-strong bg-card p-4 sm:p-5 md:p-6 text-left",
        "shadow-[0_1px_0_rgba(255,255,255,0.02),0_4px_12px_rgba(0,0,0,0.25)]",
        "transition-[border-color,background,box-shadow,transform] duration-[180ms]",
        "hover:border-brand/40 hover:bg-card-2 hover:shadow-[0_1px_0_rgba(255,255,255,0.04),0_8px_24px_rgba(0,0,0,0.4),0_0_24px_rgba(184,45,28,0.08)] hover:scale-[1.005]",
        "motion-reduce:hover:scale-100",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-focus-ring focus-visible:border-brand",
      )}
    >
      {/* Identity row: logo + name+sub + pills */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 sm:gap-4 mb-4 sm:mb-[18px]">
        {company.logoAssetId ? (
          <img
            src={`/api/assets/${company.logoAssetId}/content`}
            alt={company.name}
            className="size-12 sm:size-14 rounded-[11px] sm:rounded-[13px] shrink-0 object-cover"
          />
        ) : (
          <CompanyPatternIcon
            companyName={company.name}
            brandColor={company.brandColor}
            className="size-12 sm:size-14 rounded-[11px] sm:rounded-[13px] shrink-0"
          />
        )}
        <div className="min-w-0">
          <div className="text-[1rem] sm:text-[1.15rem] font-bold tracking-[-0.018em] leading-[1.2] truncate text-foreground">
            {company.name}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.7rem] sm:text-[0.74rem] text-dim">
            {company.issuePrefix && (
              <span className="font-mono text-very-dim">{company.issuePrefix}</span>
            )}
            {stats && (
              <>
                <span aria-hidden>·</span>
                <span>
                  {stats.agentCount} {stats.agentCount === 1 ? "agent" : "agents"}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Pills — always reserve 22px height so layout never shifts */}
        <div className="min-h-[22px] flex flex-wrap items-center justify-end gap-1.5 shrink-0">
          {showLive && (
            <span className="inline-flex h-[22px] items-center gap-1 rounded-full border border-brand/30 bg-gradient-to-b from-brand/20 to-brand/[0.12] px-2 pl-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.04em] text-[hsl(15_70%_80%)]">
              <span className="size-[5px] rounded-full bg-brand animate-[pulse_1.5s_ease-in-out_infinite] shadow-[0_0_6px_rgba(184,45,28,0.6)]" />
              live
            </span>
          )}
          {showPending && (
            <span className="inline-flex h-[22px] items-center rounded-full border border-warning/30 bg-gradient-to-b from-warning/[0.18] to-warning/[0.10] px-2 text-[0.62rem] font-semibold uppercase tracking-[0.04em] text-[hsl(45_80%_75%)]">
              {pendingCount} pending
            </span>
          )}
          {showUnread && (
            <span
              aria-label={`${unreadCount} unread notifications`}
              className="inline-flex h-[22px] items-center gap-1 rounded-full border border-border-strong bg-card-2 px-2 text-[0.62rem] font-semibold uppercase tracking-[0.04em] text-dim"
            >
              <Bell className="size-3" />
              {unreadCount} unread
            </span>
          )}
          {showFailed && (
            <span className="inline-flex h-[22px] items-center rounded-full border border-error/30 bg-gradient-to-b from-error/[0.18] to-error/[0.10] px-2 text-[0.62rem] font-semibold uppercase tracking-[0.04em] text-[hsl(0_80%_78%)]">
              {failedCount} failed
            </span>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3 sm:gap-5 md:gap-6 border-y border-border-soft py-3 sm:py-3.5 mb-3 sm:mb-4">
        {statsLoading ? (
          <>
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-7 w-20" />
          </>
        ) : (
          <>
            <StatCell
              label="Active tasks"
              value={stats ? String(stats.issueCount) : "—"}
              muted={!stats || stats.issueCount === 0}
            />
            <StatCell
              label="Pending approvals"
              value={stats ? String(pendingCount) : "—"}
              tone={showPending ? "warning" : "default"}
              muted={!showPending}
            />
            <StatCell
              label="Tasks today"
              value={tasksTodayCount !== undefined ? String(tasksTodayCount) : "—"}
              muted
            />
          </>
        )}
      </div>

      {/* Activity section (placeholder until backend exposes recent activity) */}
      <div className="flex flex-col gap-1">
        <div className="mb-1.5 text-[0.62rem] font-medium uppercase tracking-[0.07em] text-very-dim">
          Recent activity
        </div>
        <div className="flex items-center gap-2.5 py-1 text-[0.78rem] text-dim">
          <span className="size-[7px] shrink-0 rounded-full bg-[hsl(0_0%_30%)]" aria-hidden />
          <span className="text-very-dim">—</span>
          <span className="flex-1 truncate opacity-60">Recent activity will appear here</span>
        </div>
      </div>
    </button>
  );
}

interface StatCellProps {
  label: string;
  value: string;
  tone?: "default" | "warning" | "error";
  muted?: boolean;
}

function StatCell({ label, value, tone = "default", muted = false }: StatCellProps) {
  return (
    <div className="text-left">
      <div className="mb-1.5 text-[0.62rem] font-medium uppercase tracking-[0.07em] text-very-dim">
        {label}
      </div>
      <div
        className={cn(
          "font-mono text-[1.15rem] sm:text-[1.3rem] md:text-[1.45rem] font-bold tracking-[-0.025em] leading-none text-foreground",
          tone === "warning" && "text-warning",
          tone === "error" && "text-error",
          muted && tone === "default" && "text-very-dim",
        )}
      >
        {value}
      </div>
    </div>
  );
}
