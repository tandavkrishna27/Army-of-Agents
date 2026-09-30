// ui/src/components/workspace/transcript/classify-entry.ts

import type { DepartmentType, EntryCategory } from "./types";

// --- Exact name matches (universal, always checked) ---

const UNIVERSAL_NAME_MAP: Record<string, EntryCategory> = {
  // File read
  Read: "file_read", cat: "file_read", head: "file_read", file_read: "file_read", ReadFile: "file_read",
  // File edit
  Edit: "file_edit", Write: "file_edit", file_edit: "file_edit", EditFile: "file_edit", NotebookEdit: "file_edit",
  // Search
  Grep: "search", Glob: "search", search: "search", find: "search", ripgrep: "search",
  // Command
  Bash: "command", shell: "command", bash: "command", command_execution: "command", shellToolCall: "command",
  // Web
  WebFetch: "web", WebSearch: "web", web_fetch: "web", curl: "web",
  // Progress
  TodoWrite: "progress_update", update_progress: "progress_update", set_status: "progress_update",
  // Memory
  suggest_memory: "memory_operation", context_lookup: "memory_operation",
  // Approval
  request_approval: "approval_requested", needs_review: "approval_requested",
  // File transfer
  upload_file: "file_upload", send_file: "file_upload",
  download_file: "file_download", save_as: "file_download",
  // Audio
  text_to_speech: "audio_generated", generate_audio: "audio_generated",
};

// --- Pattern matches (checked if no exact match) ---

const UNIVERSAL_PATTERNS: Array<[RegExp, EntryCategory]> = [
  [/^recall_/i, "memory_operation"],
  [/^attach_/i, "file_upload"],
  [/^export_/i, "file_download"],
  [/^voice_/i, "audio_generated"],
  [/^podcast_/i, "audio_generated"],
  [/^api_request$/i, "api_call"],
  [/^http_/i, "api_call"],
  [/^rest_/i, "api_call"],
  [/^graphql_/i, "api_call"],
];

// --- Department-specific name maps ---

const DEPARTMENT_NAME_MAPS: Partial<Record<DepartmentType, Record<string, EntryCategory>>> = {
  software_development: {},
  marketing: {
    generate_copy: "content_generated", write_content: "content_generated",
    generate_image: "image_generated", "dall-e": "image_generated", midjourney: "image_generated", "stable-diffusion": "image_generated",
    generate_video: "video_generated", create_video: "video_generated", video_edit: "video_generated",
    analyze_audience: "research", competitor_analysis: "research", market_research: "research",
    schedule_post: "social_post", create_post: "social_post", draft_social: "social_post",
    seo_audit: "seo_analysis", keyword_research: "seo_analysis",
    draft_email: "email_campaign", email_template: "email_campaign",
    pull_analytics: "analytics_pulled", analytics_report: "analytics_pulled",
  },
  finance: {
    calculate: "calculation", compute: "calculation", formula: "calculation",
    query_data: "data_query", sql: "data_query", fetch_report: "data_query", pull_metrics: "data_query",
    generate_report: "report_generated", financial_summary: "report_generated", forecast: "report_generated",
    create_chart: "chart_generated", visualize: "chart_generated", plot: "chart_generated",
    create_invoice: "invoice_generated", generate_statement: "invoice_generated",
    audit_check: "compliance_check", compliance_verify: "compliance_check",
  },
  support: {
    search_tickets: "ticket_lookup", get_ticket: "ticket_lookup",
    search_kb: "knowledge_search", knowledge_base: "knowledge_search", help_center: "knowledge_search",
    draft_reply: "draft_response", compose_response: "draft_response", suggest_answer: "draft_response",
    escalate: "escalation", transfer: "escalation", assign_agent: "escalation",
    analyze_sentiment: "sentiment_analyzed", customer_mood: "sentiment_analyzed",
    apply_macro: "macro_applied", canned_response: "macro_applied", template_reply: "macro_applied",
  },
  design: {
    generate_design: "design_asset", create_mockup: "design_asset",
    brand_guidelines: "brand_check", style_check: "brand_check", consistency_audit: "brand_check",
    resize_image: "media_processed", compress_video: "media_processed", convert_format: "media_processed",
    create_animation: "animation_created",
    create_prototype: "prototype_created", interactive_mockup: "prototype_created",
  },
  hr: {
    search_candidates: "candidate_lookup", get_applicant: "candidate_lookup",
    draft_offer: "document_drafted", draft_policy: "document_drafted", write_handbook: "document_drafted",
    schedule_interview: "schedule_action", book_meeting: "schedule_action",
    run_background: "background_check",
    training_assigned: "onboarding_step", setup_account: "onboarding_step",
  },
  legal: {
    draft_contract: "contract_drafted", generate_agreement: "contract_drafted",
    review_clause: "clause_reviewed", check_terms: "clause_reviewed", legal_review: "clause_reviewed",
    check_regulation: "regulatory_check",
  },
  research: {
    search_papers: "literature_search",
    analyze_data: "data_analysis", run_experiment: "data_analysis", statistical_test: "data_analysis",
    cite: "citation", add_reference: "citation", bibliography: "citation",
    run_simulation: "experiment_run", model_train: "experiment_run",
  },
  operations: {
    trigger_workflow: "workflow_triggered", run_pipeline: "workflow_triggered",
    check_inventory: "inventory_check",
    send_notification: "notification_sent",
  },
};

const DEPARTMENT_PATTERNS: Partial<Record<DepartmentType, Array<[RegExp, EntryCategory]>>> = {
  marketing: [
    [/^draft_/i, "content_generated"],
    [/^animate_/i, "video_generated"],
    [/^campaign_/i, "email_campaign"],
    [/^ga_/i, "analytics_pulled"],
  ],
  finance: [
    [/^spreadsheet_/i, "calculation"],
    [/^validate_/i, "compliance_check"],
  ],
  support: [
    [/^zendesk_/i, "ticket_lookup"],
    [/^freshdesk_/i, "ticket_lookup"],
    [/^nps_/i, "sentiment_analyzed"],
  ],
  design: [
    [/^figma_/i, "design_asset"],
    [/^lottie_/i, "animation_created"],
    [/^motion_/i, "animation_created"],
  ],
  hr: [
    [/^ats_/i, "candidate_lookup"],
    [/^verify_/i, "background_check"],
    [/^onboard_/i, "onboarding_step"],
    [/^calendar_/i, "schedule_action"],
  ],
  legal: [
    [/^nda_/i, "contract_drafted"],
    [/^compliance_/i, "regulatory_check"],
    [/^gdpr_/i, "regulatory_check"],
  ],
  research: [
    [/^arxiv_/i, "literature_search"],
    [/^pubmed_/i, "literature_search"],
    [/^scholar_/i, "literature_search"],
    [/^benchmark_/i, "experiment_run"],
  ],
  operations: [
    [/^automate_/i, "workflow_triggered"],
    [/^stock_/i, "inventory_check"],
    [/^warehouse_/i, "inventory_check"],
    [/^alert_/i, "notification_sent"],
    [/^notify_/i, "notification_sent"],
  ],
};

// --- Command content analysis (for software_development department) ---

function classifyCommandContent(input: unknown): EntryCategory | null {
  const command = extractCommand(input);
  if (!command) return null;

  if (/\bgit\s+(?:commit|push|pull|merge|rebase|checkout|branch|stash|log|diff|add|reset|cherry-pick|tag)\b/i.test(command)) return "git_operation";
  if (/\bgit\s+status\b/i.test(command)) return "git_operation";
  if (/\b(?:npm\s+test|npx\s+vitest|npx\s+jest|pytest|cargo\s+test|go\s+test|rspec|mocha)\b/i.test(command)) return "test_run";
  if (/\b(?:npm\s+run\s+build|npx\s+tsc|cargo\s+build|make\b|gradle\s+build|mvn\s+(?:compile|package))\b/i.test(command)) return "build";

  return null;
}

function extractCommand(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    if (typeof record.cmd === "string") return record.cmd;
  }
  return null;
}

// --- Main classifier ---

export function classifyToolEntry(
  name: string,
  input: unknown,
  departmentType: DepartmentType,
): EntryCategory {
  // 1. Universal exact match
  const universal = UNIVERSAL_NAME_MAP[name];
  if (universal) {
    // Special case: command entries get further classified in software_development
    if (universal === "command" && departmentType === "software_development") {
      const commandCategory = classifyCommandContent(input);
      if (commandCategory) return commandCategory;
    }
    return universal;
  }

  // 2. Department-specific exact match
  const deptMap = DEPARTMENT_NAME_MAPS[departmentType];
  if (deptMap) {
    const deptMatch = deptMap[name];
    if (deptMatch) return deptMatch;
  }

  // 3. Universal pattern match
  for (const [pattern, category] of UNIVERSAL_PATTERNS) {
    if (pattern.test(name)) return category;
  }

  // 4. Department-specific pattern match
  const deptPatterns = DEPARTMENT_PATTERNS[departmentType];
  if (deptPatterns) {
    for (const [pattern, category] of deptPatterns) {
      if (pattern.test(name)) return category;
    }
  }

  // 5. Fallback
  return "generic_tool";
}
