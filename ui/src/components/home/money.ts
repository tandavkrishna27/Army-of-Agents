/** Cents → "$1,234" (whole dollars) for compact widget display. */
export function formatDollars(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.round(cents / 100));
}
