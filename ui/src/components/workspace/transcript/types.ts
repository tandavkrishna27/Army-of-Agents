// ui/src/components/workspace/transcript/types.ts

// --- Department types (matches project.functionType field) ---

export type DepartmentType =
  | "software_development"
  | "marketing"
  | "finance"
  | "support"
  | "hr"
  | "legal"
  | "research"
  | "design"
  | "operations"
  | "general"
  | "custom";

// --- TranscriptBlock (ported from Paperclip RunTranscriptView.tsx:30-107) ---

export type TranscriptBlock =
  | {
      type: "message";
      role: "assistant" | "user";
      ts: string;
      text: string;
      streaming: boolean;
    }
  | {
      type: "thinking";
      ts: string;
      text: string;
      streaming: boolean;
    }
  | {
      type: "tool";
      ts: string;
      endTs?: string;
      name: string;
      toolUseId?: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      status: "running" | "completed" | "error";
    }
  | {
      type: "activity";
      ts: string;
      activityId?: string;
      name: string;
      status: "running" | "completed";
    }
  | {
      type: "command_group";
      ts: string;
      endTs?: string;
      items: Array<{
        ts: string;
        endTs?: string;
        input: unknown;
        result?: string;
        isError?: boolean;
        status: "running" | "completed" | "error";
      }>;
    }
  | {
      type: "tool_group";
      ts: string;
      endTs?: string;
      items: Array<{
        ts: string;
        endTs?: string;
        name: string;
        input: unknown;
        result?: string;
        isError?: boolean;
        status: "running" | "completed" | "error";
      }>;
    }
  | {
      type: "stderr_group";
      ts: string;
      endTs?: string;
      lines: Array<{ ts: string; text: string }>;
    }
  | {
      type: "diagnostic_group";
      ts: string;
      endTs?: string;
      lines: Array<{ ts: string; text: string }>;
    }
  | {
      type: "stdout";
      ts: string;
      text: string;
    }
  | {
      type: "event";
      ts: string;
      label: string;
      tone: "info" | "warn" | "error" | "neutral";
      text: string;
      detail?: string;
    };

// --- Entry categories for classification ---

export type UniversalCategory =
  | "message"
  | "thinking"
  | "file_read"
  | "file_edit"
  | "search"
  | "command"
  | "web"
  | "api_call"
  | "file_upload"
  | "file_download"
  | "memory_operation"
  | "approval_requested"
  | "progress_update"
  | "audio_generated"
  | "system_event"
  | "error"
  | "generic_tool";

export type SoftwareDevCategory =
  | "git_operation"
  | "test_run"
  | "build"
  | "diff_view";

export type MarketingCategory =
  | "content_generated"
  | "image_generated"
  | "video_generated"
  | "research"
  | "social_post"
  | "seo_analysis"
  | "email_campaign"
  | "analytics_pulled";

export type FinanceCategory =
  | "calculation"
  | "data_query"
  | "report_generated"
  | "chart_generated"
  | "invoice_generated"
  | "compliance_check";

export type SupportCategory =
  | "ticket_lookup"
  | "knowledge_search"
  | "draft_response"
  | "escalation"
  | "sentiment_analyzed"
  | "macro_applied";

export type DesignCategory =
  | "design_asset"
  | "brand_check"
  | "media_processed"
  | "animation_created"
  | "prototype_created";

export type HRCategory =
  | "candidate_lookup"
  | "document_drafted"
  | "schedule_action"
  | "background_check"
  | "onboarding_step";

export type LegalCategory =
  | "contract_drafted"
  | "clause_reviewed"
  | "regulatory_check";

export type ResearchCategory =
  | "literature_search"
  | "data_analysis"
  | "citation"
  | "experiment_run";

export type OperationsCategory =
  | "workflow_triggered"
  | "inventory_check"
  | "notification_sent";

export type EntryCategory =
  | UniversalCategory
  | SoftwareDevCategory
  | MarketingCategory
  | FinanceCategory
  | SupportCategory
  | DesignCategory
  | HRCategory
  | LegalCategory
  | ResearchCategory
  | OperationsCategory;

// --- Aggregated group types (pass 2 output) ---

export type AggregatedGroup =
  | { type: "read_group"; items: Extract<TranscriptBlock, { type: "tool" }>[]; count: number }
  | { type: "edit_group"; filePath: string; items: Extract<TranscriptBlock, { type: "tool" }>[]; totalAdditions: number; totalDeletions: number }
  | { type: "multi_edit_group"; items: Extract<TranscriptBlock, { type: "tool" }>[]; fileCount: number }
  | { type: "search_group"; items: Extract<TranscriptBlock, { type: "tool" }>[]; count: number }
  | { type: "web_group"; items: Extract<TranscriptBlock, { type: "tool" }>[]; count: number }
  | { type: "command_group_agg"; items: Extract<TranscriptBlock, { type: "tool" }>[]; count: number }
  | { type: "thinking_group"; items: Extract<TranscriptBlock, { type: "thinking" }>[]; isPreviousTurn: boolean }
  | { type: "generic_group"; category: EntryCategory; items: Extract<TranscriptBlock, { type: "tool" }>[]; count: number };

/** Union of block or aggregated group — the input to renderers */
export type DisplayBlock = TranscriptBlock | AggregatedGroup;

/** Aggregated group type strings for runtime checking */
const AGGREGATED_GROUP_TYPES = new Set([
  "read_group", "edit_group", "multi_edit_group", "search_group",
  "web_group", "command_group_agg", "thinking_group", "generic_group",
]);

/** Check if a DisplayBlock is an AggregatedGroup */
export function isAggregatedGroup(block: DisplayBlock): block is AggregatedGroup {
  return AGGREGATED_GROUP_TYPES.has(block.type);
}

// --- Pill metadata helpers ---

/** Parsed +/- stats from a file edit tool result */
export interface EditStats {
  additions: number;
  deletions: number;
}

/** Categories that render as rich cards instead of pills */
export const RICH_CARD_CATEGORIES: Set<EntryCategory> = new Set([
  "image_generated",
  "video_generated",
  "audio_generated",
  "content_generated",
  "report_generated",
  "chart_generated",
  "draft_response",
  "design_asset",
  "animation_created",
  "email_campaign",
]);

/** Categories eligible for consecutive grouping in pass 2 */
export const AGGREGATABLE_CATEGORIES: Set<EntryCategory> = new Set([
  "file_read",
  "file_edit",
  "search",
  "command",
  "web",
  "generic_tool",
]);
