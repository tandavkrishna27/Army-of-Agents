export type BackupStep = { name: string; run(): Promise<void> };
export type BackupBudgets = { startupMs: number; cleanupMs: number };
export function createBackupFixture(
  steps: BackupStep[], cleanup: () => Promise<void>,
  budgets: BackupBudgets = { startupMs: 30_000, cleanupMs: 25_000 },
) {
  let closing = false;
  let stage = "not started";
  let rawStartup: Promise<void> | undefined;
  let startup: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  function bound(work: Promise<void>, ms: number, expired: () => Error) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(expired()), ms);
      work.then(
        () => { clearTimeout(timer); resolve(); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  }
  function active() {
    if (closing) throw new Error("Backup fixture disposal requested");
  }
  function start(): Promise<void> {
    if (closing) return Promise.reject(new Error("Backup fixture disposed"));
    if (startup) return startup;
    rawStartup = (async () => {
      try {
        for (const step of steps) {
          active(); stage = step.name;
          await step.run(); active();
        }
      } catch (cause) {
        throw new Error(`Backup fixture setup failed during ${stage}`, { cause });
      }
    })();
    startup = bound(rawStartup, budgets.startupMs, () => {
      closing = true;
      return new Error(`Backup fixture setup exceeded ${budgets.startupMs}ms during ${stage}`);
    });
    return startup;
  }
  function dispose(): Promise<void> {
    closing = true;
    if (disposal) return disposal;
    const cleanupWork = (async () => {
      if (rawStartup) await rawStartup.catch(() => undefined);
      await cleanup();
    })();
    disposal = bound(cleanupWork, budgets.cleanupMs, () =>
      new Error(`Backup fixture cleanup exceeded ${budgets.cleanupMs}ms; last setup stage ${stage}`));
    return disposal;
  }
  return { start, dispose };
}

export async function cleanupBackupResources(owner: {
  closeClient?: () => Promise<void>;
  stop?: () => Promise<void>;
  unsafe?: string;
  directories: string[];
  remove(directory: string): Promise<void>;
}): Promise<void> {
  const errors: unknown[] = [];
  if (owner.closeClient) {
    try { await owner.closeClient(); } catch (error) { errors.push(error); }
  }
  if (owner.stop) {
    try { await owner.stop(); } catch (error) { errors.push(error); }
  }
  if (owner.unsafe) errors.push(new Error(owner.unsafe));
  if (errors.length === 0) {
    for (const directory of owner.directories) {
      try { await owner.remove(directory); } catch (error) { errors.push(error); }
    }
  }
  if (errors.length) throw new AggregateError(errors, "Backup fixture cleanup failed");
}
