import {beforeEach, expect, it, vi} from "vitest";
const h = vi.hoisted(() => ({attempts: [] as any[], collisions: 0, nextPort: 55000, migrate: vi.fn(), close: vi.fn()}));
vi.mock("embedded-postgres", () => ({default: class {
  options: any; stop = vi.fn(async () => {});
  constructor(options: any) {this.options = options; h.attempts.push(this);}
  async initialise() {}
  async start() {if (h.attempts.length <= h.collisions) this.options.onLog?.('could not bind IPv4 address "127.0.0.1": Address already in use');}
}}));
vi.mock("./helpers/embedded-pg-port.js", () => ({allocateEmbeddedPgPort: vi.fn(async () => h.nextPort++)}));
vi.mock("@armyofagents/db", () => ({applyPendingMigrations: h.migrate, createTenantAppDbConnection: () => ({db: {}, close: h.close})}));
vi.mock("../db/rls-tenant.js", () => ({provisionTenantAppRoleLoginSql: () => "role provisioning"}));
vi.mock("postgres", () => ({default: () => ({unsafe: vi.fn(async () => []), end: vi.fn(async () => {})})}));
import {startMigratedDatabase} from "./helpers/migrated-database.js";
beforeEach(() => {h.attempts.length = 0; h.collisions = 0; h.nextPort = 55000; h.migrate.mockReset(); h.close.mockReset().mockResolvedValue(undefined);});
it("discards a partially listening cluster before any migration and retries a fresh port", async () => {
 h.collisions = 1;
 const fixture = await startMigratedDatabase();
 try {
  expect(h.attempts).toHaveLength(2);
  expect(h.attempts[0].stop).toHaveBeenCalledOnce();
  expect(h.migrate).toHaveBeenCalledExactlyOnceWith("postgres://test:test@127.0.0.1:55001/postgres");
 } finally {await fixture.teardown();}
});
it("bounds startup collision retries and never migrates a partially bound cluster", async () => {
 h.collisions = 10;
 await expect(startMigratedDatabase()).rejects.toThrow(/IPv4.*3/);
 expect(h.attempts).toHaveLength(3); expect(h.migrate).not.toHaveBeenCalled();
 for (const attempt of h.attempts) expect(attempt.stop).toHaveBeenCalledOnce();
});
it("does not retry or hide migration failures", async () => {
 h.migrate.mockRejectedValueOnce(new Error("migration failed"));
 await expect(startMigratedDatabase()).rejects.toThrow("migration failed");
 expect(h.attempts).toHaveLength(1); expect(h.attempts[0].stop).toHaveBeenCalledOnce();
});
