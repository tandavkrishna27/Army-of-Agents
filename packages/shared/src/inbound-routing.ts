export const INBOUND_ROUTING_LEVELS = [
  { value: "off",         name: "Off",         blurb: "All inbound goes to the Inbox; you triage everything." },
  { value: "suggest",     name: "Suggest",     blurb: "Pre-fills a best guess; you one-click confirm each." },
  { value: "auto_attach", name: "Auto-attach", blurb: "Auto-attaches confident matches; suggests branch/new." },
  { value: "full_auto",   name: "Full-auto",   blurb: "Auto-attaches and auto-creates when confident." },
] as const;

export type InboundRoutingLevel = typeof INBOUND_ROUTING_LEVELS[number]["value"];

export function isValidRoutingLevel(v: unknown): v is InboundRoutingLevel {
  return INBOUND_ROUTING_LEVELS.some(l => l.value === v);
}

export function routingLevelLabel(v: string | null | undefined): string {
  return INBOUND_ROUTING_LEVELS.find(l => l.value === v)?.name ?? "Off";
}
