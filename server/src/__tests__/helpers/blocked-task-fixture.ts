export type FixturePostgres = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
export type FixtureDependencies<T extends object> = {
  createDirectory(): Promise<string>;
  allocatePort(): Promise<number>;
  createPostgres(directory: string, port: number): Promise<FixturePostgres>;
  migrate(url: string): Promise<void>;
  connect(url: string): T;
  seed(db: T): Promise<void>;
  closeDb(db: T): Promise<void>;
  removeDirectory(directory: string): Promise<void>;
};

export function createBlockedTaskFixture<T extends object>(d: FixtureDependencies<T>) {
  let directory: string | undefined;
  let pg: FixturePostgres | undefined;
  let db: T | undefined;
  let started = false;
  let closing = false;
  let startup: Promise<T> | undefined;
  let disposal: Promise<void> | undefined;
  let stage = "not started";

  function active() {
    if (closing) throw new Error("Fixture disposal requested during startup");
  }
  async function initialise(): Promise<T> {
    try {
      stage = "directory";
      directory = await d.createDirectory(); active();
      stage = "port";
      const port = await d.allocatePort(); active();
      stage = "construct";
      pg = await d.createPostgres(directory, port); active();
      stage = "initialise";
      await pg.initialise(); active();
      stage = "start";
      await pg.start();
      started = true;
      active();
      const url = `postgres://test:test@127.0.0.1:${port}/postgres`;
      stage = "migrate";
      await d.migrate(url); active();
      stage = "connect";
      db = d.connect(url); active();
      stage = "seed";
      await d.seed(db); active();
      return db;
    } catch (cause) {
      throw new Error(`Blocked-task fixture failed during ${stage}`, { cause });
    }
  }
  function start(): Promise<T> {
    if (closing) return Promise.reject(new Error("Fixture has been disposed"));
    return startup ??= initialise();
  }
  function dispose(): Promise<void> {
    closing = true;
    return disposal ??= (async () => {
      // Observe pending startup before cleaning up its resources. Its original
      // rejection still reaches the caller of start()/Vitest beforeAll.
      if (startup) await startup.catch(() => undefined);
      const errors: unknown[] = [];
      if (db) {
        try { await d.closeDb(db); } catch (error) { errors.push(error); }
      }
      if (started && pg) {
        try { await pg.stop(); started = false; }
        catch (error) { errors.push(error); }
      }
      // A failed stop must never be followed by deletion of a live cluster.
      if (directory && !started && errors.length === 0) {
        try { await d.removeDirectory(directory); }
        catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Blocked-task fixture cleanup failed");
    })();
  }
  return { start, dispose };
}
