const DEFAULT_CREW_INSTALL_DEADLINE_MS = 30_000;
const MAX_CREW_INSTALL_DEADLINE_MS = 120_000;

export function resolveCrewInstallDeadlineMs(
  raw = process.env.AOA_CREW_INSTALL_DEADLINE_MS,
): number {
  if (raw === undefined || raw.trim() === "")
    return DEFAULT_CREW_INSTALL_DEADLINE_MS;
  const configured = Number(raw);
  if (
    !Number.isSafeInteger(configured) ||
    configured < DEFAULT_CREW_INSTALL_DEADLINE_MS ||
    configured > MAX_CREW_INSTALL_DEADLINE_MS
  ) {
    return DEFAULT_CREW_INSTALL_DEADLINE_MS;
  }
  return configured;
}
