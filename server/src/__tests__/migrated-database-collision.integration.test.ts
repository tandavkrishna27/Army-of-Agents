import net from "node:net";
import {expect, it, vi} from "vitest";
const forced = vi.hoisted(() => ({port: 0, calls: 0}));
vi.mock("./helpers/embedded-pg-port.js", async importOriginal => {
 const actual = await importOriginal<typeof import("./helpers/embedded-pg-port.js")>();
 return {allocateEmbeddedPgPort: async () => {
  forced.calls += 1;
  return forced.calls === 1 ? forced.port : actual.allocateEmbeddedPgPort();
 }};
});
import {startMigratedDatabase} from "./helpers/migrated-database.js";
it.skipIf(process.platform === "win32")("recovers a real IPv4 port collision before migration", async () => {
 const blocker = net.createServer(socket => socket.destroy());
 await new Promise<void>((resolve, reject) => {blocker.once("error", reject); blocker.listen(0, "127.0.0.1", resolve);});
 forced.port = (blocker.address() as net.AddressInfo).port; forced.calls = 0;
 let fixture: Awaited<ReturnType<typeof startMigratedDatabase>> | undefined;
 try {
  fixture = await startMigratedDatabase({label: "aoa-collision-proof-"});
  expect(forced.calls).toBe(2);
  expect(new URL(fixture.adminUrl).port).not.toBe(String(forced.port));
  const rows = await fixture.admin`select current_user as username`;
  expect(rows[0].username).toBe("test");
 } finally {
  await fixture?.teardown();
  await new Promise<void>((resolve, reject) => blocker.close(error => error ? reject(error) : resolve()));
 }
}, 180_000);
