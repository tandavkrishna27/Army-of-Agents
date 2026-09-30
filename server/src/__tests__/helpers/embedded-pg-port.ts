import net from "node:net";

/**
 * Allocate a free localhost TCP port for an embedded-postgres cluster, probing
 * upward from a random start until a genuinely-free port is found.
 *
 * WHY: the server vitest config runs test FILES in parallel (default pool), and
 * the *.integration.test.ts suites otherwise each pick a port from a FIXED random
 * range (roughly 57000-62000) that OVERLAPS many sibling suites, with no
 * collision-safe allocation. Two concurrently-booting suites can therefore select
 * the same port and one `pg.start()` fails with EADDRINUSE — an intermittent CI
 * flake. Probing for a genuinely-free port removes the caller from that collision
 * equation.
 *
 * A tiny TOCTOU window remains between closing the probe socket and embedded-pg
 * binding the port (same as the e2e config's pickAvailablePort), but it is far
 * safer than holding a fixed random range for the whole suite. New embedded-pg
 * integration suites should use this; the existing fixed-range suites can adopt
 * it incrementally.
 */
export async function allocateEmbeddedPgPort(
  preferred = 55_000 + Math.floor(Math.random() * 10_000),
): Promise<number> {
  for (let port = preferred; port <= 65_535; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error(`No free port available at or above ${preferred}`);
}
