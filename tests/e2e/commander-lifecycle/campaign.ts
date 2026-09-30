import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { APIRequestContext, APIResponse, Browser, BrowserContext } from "@playwright/test";

export const LIVE_SCENARIO_IDS = [
  "R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10", "R11", "R12", "R13", "R14",
  "Q1", "Q2", "Q3", "Q4", "Q5",
] as const;

export type LiveScenarioId = (typeof LIVE_SCENARIO_IDS)[number];
export type LiveScenarioStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

export interface CampaignActor {
  userId: string;
  email: string;
  storageStatePath: string;
}
export interface CampaignTask {
  id: string;
  identifier: string;
  title: string;
  agent: "claude" | "codex" | "human";
  answerSurface?: "commander" | "workspace" | "discussion" | "inbox" | "task_work";
  expectedAnswer?: string;
  outputFile?: string;
  questionId?: string;
  workspaceId?: string;
  runId?: string;
}
export interface CampaignState {
  version: 1;
  campaignId: string;
  baseUrl: string;
  startedAt: string;
  company: { id: string; name: string; issuePrefix: string };
  actors: {
    founder: CampaignActor;
    lead: CampaignActor;
    member: CampaignActor;
  };
  projects: {
    productDepartmentId: string;
    engineeringDepartmentId: string;
    customerValidationProjectId: string;
  };
  goalId: string;
  discussionId: string;
  agents: {
    claude: { id: string; name: string };
    codex: { id: string; name: string };
  };
  tasks: Record<string, CampaignTask>;
  scenarios: Partial<Record<LiveScenarioId, {
    status: LiveScenarioStatus;
    finishedAt: string;
    detail: string;
    evidence?: string[];
  }>>;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Commander lifecycle campaign`);
  return value;
}

export function campaignId(): string {
  return requiredEnv("AOA_COMMANDER_LIFECYCLE_CAMPAIGN_ID");
}

export function campaignRoot(): string {
  return resolve(requiredEnv("AOA_COMMANDER_LIFECYCLE_DIR"));
}

export function statePath(): string {
  return resolve(campaignRoot(), "STATE.json");
}

export function checkpointPath(phase: string): string {
  return resolve(campaignRoot(), "checkpoints", `${phase}.json`);
}

export function actorStoragePath(actor: "founder" | "lead" | "member"): string {
  return resolve(campaignRoot(), "auth", `${actor}.json`);
}

export async function loadState(): Promise<CampaignState> {
  return JSON.parse(await readFile(statePath(), "utf8")) as CampaignState;
}

export async function saveState(state: CampaignState): Promise<void> {
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function updateState(mutator: (state: CampaignState) => void | Promise<void>): Promise<CampaignState> {
  const state = await loadState();
  await mutator(state);
  await saveState(state);
  return state;
}

export async function recordScenario(
  id: LiveScenarioId,
  status: LiveScenarioStatus,
  detail: string,
  evidence: string[] = [],
): Promise<void> {
  await updateState((state) => {
    state.scenarios[id] = { status, detail, evidence, finishedAt: new Date().toISOString() };
  });
}

export async function writeCheckpoint(phase: string, payload: Record<string, unknown>): Promise<void> {
  const path = checkpointPath(phase);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ phase, finishedAt: new Date().toISOString(), ...payload }, null, 2)}\n`, "utf8");
}

export async function requireCheckpoint(phase: string): Promise<void> {
  try {
    await readFile(checkpointPath(phase), "utf8");
  } catch {
    throw new Error(`BLOCKED: prerequisite checkpoint ${phase} is missing`);
  }
}

export async function jsonOrThrow<T>(response: APIResponse, label: string): Promise<T> {
  if (!response.ok()) {
    throw new Error(`${label} failed: ${response.status()} ${await response.text().catch(() => "(no body)")}`);
  }
  return response.json() as Promise<T>;
}

export async function poll<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<T> {
  const startedAt = Date.now();
  let last: T | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)}`);
}

export async function signUpActor(browser: Browser, baseUrl: string, label: string): Promise<{
  context: BrowserContext;
  userId: string;
  email: string;
}> {
  const context = await browser.newContext({ baseURL: baseUrl, extraHTTPHeaders: { Origin: baseUrl } });
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const email = `${slug}-${campaignId()}@commander-lifecycle.test`;
  await jsonOrThrow(
    await context.request.post("/api/auth/sign-up/email", {
      data: { name: label, email, password: "Commander-Lifecycle-2026!" },
    }),
    `sign up ${label}`,
  );
  const session = await jsonOrThrow<{ user: { id: string } }>(
    await context.request.get("/api/auth/get-session"),
    `load ${label} session`,
  );
  return { context, userId: session.user.id, email };
}

export async function authenticatedRequest(
  browser: Browser,
  state: CampaignState,
  actor: keyof CampaignState["actors"],
): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: state.baseUrl,
    storageState: state.actors[actor].storageStatePath,
    extraHTTPHeaders: { Origin: state.baseUrl },
  });
}

export async function listQuestions(
  request: APIRequestContext,
  companyId: string,
  issueId: string,
): Promise<Array<Record<string, unknown>>> {
  return jsonOrThrow(
    await request.get(`/api/companies/${companyId}/work-questions?issueId=${issueId}&scope=all&limit=20`),
    `list work questions for ${issueId}`,
  );
}
