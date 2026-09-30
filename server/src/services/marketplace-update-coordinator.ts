/**
 * Process-local serialization for marketplace installed-item mutations.
 *
 * Catalog fetch/cache work may be shared freely, but pending-update rows and
 * notifications must not race an instance-admin reconciliation's audited
 * boundary. The admin operation acquires this lock before refreshing and holds
 * it through its completion audit. Periodic/manual catalog syncs acquire it
 * only for their update-check continuation.
 */
let marketplaceUpdateTail: Promise<void> = Promise.resolve();

export async function withMarketplaceUpdateLock<T>(
  work: () => Promise<T>,
): Promise<T> {
  const previous = marketplaceUpdateTail;
  let release!: () => void;
  marketplaceUpdateTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}
