/**
 * Plan 3 Task 8 — company + thread crew kill-switch.
 *
 * Two-level pause: company-wide halt (internal_agent_config.crewPaused)
 * and per-thread pause (discussions.crewPaused). Either halts crew dispatch.
 *
 * Wire `isCrewPaused` into dispatcher.ts BEFORE invoking any crew role.
 * On company pause, also call cancelCrewRunsForCompany() (from heartbeat.ts)
 * to stop in-flight runs.
 *
 * Pause/resume endpoints:
 *   POST /companies/:companyId/discussions/:id/crew/pause
 *   POST /companies/:companyId/discussions/:id/crew/resume
 *   (company-level pause: PATCH /api/companies/:id/internal-agent-config)
 */

export function isCrewPaused(state: { companyPaused: boolean; threadPaused: boolean }): boolean {
  return state.companyPaused || state.threadPaused;
}
