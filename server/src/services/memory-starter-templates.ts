/**
 * Memory Starter Templates
 *
 * Static, pre-built domain-layer memory items for 11 common department
 * function types. Founders can apply a template when their memory is empty
 * or when they create a new department — seeding it with opinionated
 * defaults they can immediately edit.
 *
 * Design decisions:
 *   - Static data in code (no DB table) — templates are immutable product
 *     content, not user data.
 *   - Applied items land as status:"approved", source:"template" with
 *     sourceContext:"template:<templateId>" for idempotency.
 *   - departmentId is optional — templates can be applied company-wide
 *     (null) or scoped to a specific department.
 *   - Re-applying the same template to the same company is a no-op
 *     (idempotency guard on sourceContext prefix).
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { memoryItems } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "memory-starter-templates" });

export interface MemoryTemplateItem {
  title: string;
  content: string;
  category:
    | "preference"
    | "procedure"
    | "reference"
    | "decision"
    | "policy"
    | "context"
    | "insight";
  tags?: string[];
}

export interface MemoryStarterTemplate {
  id: string;
  name: string;
  description: string;
  /** Maps to the project.functionType field on departments/projects. */
  functionType: string;
  items: MemoryTemplateItem[];
}

// ── Template data ────────────────────────────────────────────────────────────

export const MEMORY_STARTER_TEMPLATES: MemoryStarterTemplate[] = [
  // ── 1. Engineering ────────────────────────────────────────────────────────
  {
    id: "engineering",
    name: "Engineering",
    description: "Code quality, deployment, testing, and security standards for software teams.",
    functionType: "software_development",
    items: [
      {
        title: "Tech stack decisions",
        category: "decision",
        content:
          "We build with TypeScript everywhere (frontend + backend). React + TailwindCSS on the frontend. Node.js + Express + PostgreSQL on the backend. No new framework introductions without a written ADR and team consensus.",
        tags: ["stack", "architecture"],
      },
      {
        title: "Code review standards",
        category: "preference",
        content:
          "All code must be reviewed before merging. PRs should be small (<400 lines) and focused on one concern. Blocking comments must be resolved; suggestions are optional. Self-merges allowed for trivial docs-only changes.",
        tags: ["code-review", "pr"],
      },
      {
        title: "Deployment procedure",
        category: "procedure",
        content:
          "1. All CI checks must pass. 2. Deploys run Monday–Thursday, not Friday afternoon. 3. Production deploys are tagged with version + changelog. 4. Engineer who deploys monitors for 30 minutes post-deploy. 5. Rollback via git revert + re-deploy — no hotfixes directly to production.",
        tags: ["deployment", "process"],
      },
      {
        title: "Testing standards",
        category: "preference",
        content:
          "Unit tests for all service methods. Integration tests for every API route. E2E tests for critical paths only (auth, checkout, export). Target 70%+ coverage on the services layer. Tests live in __tests__/ next to the source file they test.",
        tags: ["testing", "quality"],
      },
      {
        title: "Security baseline",
        category: "policy",
        content:
          "No secrets in code or git history — all secrets go in environment variables. Run npm audit monthly. All external inputs validated with a schema. HTTPS everywhere. No SQL string concatenation — parameterized queries only.",
        tags: ["security", "policy"],
      },
      {
        title: "Bug severity triage",
        category: "procedure",
        content:
          "P0 (service down / data loss): page on-call immediately, fix within 2 hours. P1 (feature broken for all users): fix within 24 hours. P2 (feature degraded, workaround exists): schedule in next sprint. All bugs need a written repro step before assignment.",
        tags: ["bugs", "triage", "process"],
      },
      {
        title: "Documentation rules",
        category: "preference",
        content:
          "Every public API route needs a JSDoc comment. Complex business logic gets an inline comment explaining WHY, not what. README updated with each major feature. Architecture decisions recorded as ADRs in docs/decisions/.",
        tags: ["documentation", "standards"],
      },
      {
        title: "On-call expectations",
        category: "policy",
        content:
          "On-call rotation: 1-week shifts. Response SLA: P0 within 15 minutes, P1 within 1 hour. On-call engineer has authority to revert any deploy. All incidents documented in a post-mortem within 48 hours of resolution.",
        tags: ["on-call", "incidents"],
      },
    ],
  },

  // ── 2. Marketing ─────────────────────────────────────────────────────────
  {
    id: "marketing",
    name: "Marketing",
    description: "Brand voice, content strategy, channel priorities, and campaign standards.",
    functionType: "marketing",
    items: [
      {
        title: "Brand voice",
        category: "preference",
        content:
          "Casual but credible. Write like you're explaining to a smart friend, not presenting to a board. Active voice. Short sentences. Never use corporate jargon ('synergy', 'leverage', 'utilize'). Say 'we' and 'you', not 'the company' and 'users'. Aim for a 6th-grade reading level.",
        tags: ["brand", "voice", "tone"],
      },
      {
        title: "Content pillars",
        category: "reference",
        content:
          "Three content pillars: (1) Product education — how to get more value from the tool. (2) Founder story — behind-the-scenes and lessons learned. (3) Industry insight — trends relevant to our audience. Approximate split: 40% education, 30% story, 30% insight.",
        tags: ["content", "strategy"],
      },
      {
        title: "Primary distribution channels",
        category: "decision",
        content:
          "Primary: LinkedIn for professional reach, email newsletter for retention. Secondary: Twitter/X for community. We do not maintain Instagram, TikTok, or Facebook until we reach 5K email subscribers. Podcast/YouTube only after 10K subscribers.",
        tags: ["channels", "distribution"],
      },
      {
        title: "Content publishing checklist",
        category: "procedure",
        content:
          "Before publishing: (1) proofread once, (2) verify all links work, (3) add an image or visual, (4) review CTA clarity. Schedule posts at least 24 hours in advance unless news-reactive. All blog posts reviewed by founder before publish.",
        tags: ["publishing", "checklist"],
      },
      {
        title: "Email newsletter standards",
        category: "preference",
        content:
          "Weekly newsletter: sent Tuesday 10am in the primary timezone. Subject lines under 50 characters, no emojis. One primary CTA per email. Plain text version maintained. Unsubscribe link prominent. Reply-to is a monitored inbox.",
        tags: ["email", "newsletter"],
      },
      {
        title: "Paid campaign approval policy",
        category: "policy",
        content:
          "Any paid campaign over $200/day requires founder approval before launch. A/B tests run for at least 7 days or 1,000 impressions before calling a winner. Campaign results documented in the budget tracker within 1 week of completion.",
        tags: ["campaigns", "paid", "approval"],
      },
      {
        title: "Feature launch sequence",
        category: "procedure",
        content:
          "Launch playbook: (1) T-7 days: email waitlist teaser, (2) T-3 days: social preview post, (3) T-0: launch post with demo + link, (4) T+7 days: results summary post. Always capture a demo GIF or screenshot before launch day.",
        tags: ["launch", "process"],
      },
      {
        title: "Competitor tracking cadence",
        category: "reference",
        content:
          "Review top 3 competitors' newsletters, social, and pricing pages monthly. Document changes in the competitor file. Never copy directly — understand the strategy and find differentiated positioning. We compete on founder-friendliness, not feature count.",
        tags: ["competitors", "research"],
      },
    ],
  },

  // ── 3. Product ────────────────────────────────────────────────────────────
  {
    id: "product",
    name: "Product Management",
    description: "Prioritization framework, shipping cadence, and success metrics.",
    functionType: "product_management",
    items: [
      {
        title: "Prioritization framework",
        category: "decision",
        content:
          "A feature needs: (1) at least 3 customer requests, or (2) direct link to a top-3 goal, or (3) founder conviction backed by data. Nice-to-haves go in the backlog. Vanity metrics (page views, app downloads) do not drive prioritization.",
        tags: ["prioritization", "process"],
      },
      {
        title: "Product spec standard",
        category: "procedure",
        content:
          "Every feature needs a one-pager before design starts: problem statement, target user, success metric, non-goals, and rough effort estimate. One-pagers live in the product docs folder. No spec = no design work starts.",
        tags: ["specs", "process", "documentation"],
      },
      {
        title: "Customer feedback loop",
        category: "procedure",
        content:
          "Customer interviews: minimum 1 per week. Notes summarized and tagged within 24 hours. Insights reviewed in weekly product sync. Support tickets triaged daily — any ticket mentioning 'can\\'t', 'broken', or 'confused' flagged for product review.",
        tags: ["customer", "feedback", "research"],
      },
      {
        title: "Shipping cadence",
        category: "preference",
        content:
          "We ship weekly. Every Monday: review what shipped last week and what ships this week. No feature held longer than 6 weeks without a ship decision. Prefer a partial feature shipped over a perfect feature delayed. Flag blockers immediately.",
        tags: ["shipping", "cadence"],
      },
      {
        title: "North star and KPIs",
        category: "reference",
        content:
          "North star metric: weekly active users who complete a core action. Supporting: activation rate (Day 1 core action complete), Day-7 retention, NPS (monthly survey). Vanity metrics tracked separately and never used for go/no-go decisions.",
        tags: ["metrics", "kpis", "north-star"],
      },
      {
        title: "Feature rollout policy",
        category: "policy",
        content:
          "New features launch to internal users first (1 week), then 10% of new signups (1 week), then full rollout. Feature flags used for all major changes. Kill switch must exist before launch day. No irreversible changes without a data migration plan.",
        tags: ["rollout", "feature-flags"],
      },
      {
        title: "User research standards",
        category: "preference",
        content:
          "Usability tests: at least 5 participants before concluding a pattern exists. Surveys: minimum 50 responses for quantitative conclusions. All findings documented with date, participant count, and key quotes. Avoid leading questions.",
        tags: ["user-research", "standards"],
      },
      {
        title: "Technical debt policy",
        category: "policy",
        content:
          "20% of every sprint allocated to tech debt and quality work. No new feature built on critical known debt without a plan to address it first. Debt items tracked in the backlog with estimated impact. Reviewed in monthly retrospective.",
        tags: ["tech-debt", "quality"],
      },
    ],
  },

  // ── 4. Sales ─────────────────────────────────────────────────────────────
  {
    id: "sales",
    name: "Sales",
    description: "Ideal customer profile, qualification process, and closing standards.",
    functionType: "sales",
    items: [
      {
        title: "Ideal customer profile",
        category: "reference",
        content:
          "Primary ICP: B2B SaaS founders, 1–10 person teams, $10K–$500K ARR. Pain: manually handling tasks that should be automated but can't afford a big team. Anti-ICP: enterprise (>500 employees), regulated industries without a compliance champion.",
        tags: ["icp", "target-customer"],
      },
      {
        title: "Lead qualification (MEDDIC)",
        category: "procedure",
        content:
          "Qualify using MEDDIC: Metrics (what improvement do they need?), Economic Buyer (who signs?), Decision Criteria (what does 'good' look like?), Decision Process (how do they buy?), Identify Pain (cost of inaction?), Champion (internal advocate?). Do not advance to demo without Economic Buyer and Pain confirmed.",
        tags: ["qualification", "meddic", "sales-process"],
      },
      {
        title: "Demo structure",
        category: "procedure",
        content:
          "30-minute format: 5 min discovery (restate their pain), 20 min product walk (lead with the pain-solving flow), 5 min Q+A and next steps. Always end with a specific next step with a date. Never demo features unrelated to their stated pain.",
        tags: ["demo", "sales-process"],
      },
      {
        title: "Pricing and discounting policy",
        category: "policy",
        content:
          "Standard pricing is non-negotiable except for: (1) annual prepay (up to 20% discount), (2) design-partner pilots (custom). No 'we're a startup' discounts — everyone is. All non-standard pricing requires founder approval. Document every discount with a reason.",
        tags: ["pricing", "discounting", "policy"],
      },
      {
        title: "Follow-up cadence",
        category: "preference",
        content:
          "After demo: follow up same day with a summary + next steps. No response: follow up Day 3, Day 7, Day 14, then mark inactive. 4 touches max before marking ghosted. All follow-ups personalized. CRM updated within 24 hours of every interaction.",
        tags: ["follow-up", "cadence", "crm"],
      },
      {
        title: "Price objection handling",
        category: "reference",
        content:
          "When price is the objection: (1) reframe to ROI ('What would it be worth to you if X?'), (2) confirm they understand what's included, (3) offer annual plan. If still objecting, ask 'Is price the only thing stopping you?' — if yes, they're likely not the economic buyer.",
        tags: ["objections", "price", "negotiation"],
      },
      {
        title: "Contract and closing process",
        category: "procedure",
        content:
          "Verbal agreement → send contract within 2 hours. Payment: card or wire, net-30 max. All contracts reviewed by founder before sending. Signed contract = start of onboarding sequence. Update CRM to Closed Won, notify team.",
        tags: ["closing", "contract", "process"],
      },
      {
        title: "Lost deal debrief",
        category: "procedure",
        content:
          "Every lost deal over $1K: 15-min debrief within 1 week. Questions: (1) Deciding factor? (2) Did we qualify correctly? (3) What would we do differently? (4) Re-engagement path in 6 months? Log in CRM. Patterns reviewed monthly.",
        tags: ["lost-deals", "debrief", "learning"],
      },
    ],
  },

  // ── 5. Customer Support ───────────────────────────────────────────────────
  {
    id: "customer-support",
    name: "Customer Support",
    description: "Response SLAs, tone standards, and escalation policies.",
    functionType: "customer_support",
    items: [
      {
        title: "Response time SLAs",
        category: "policy",
        content:
          "P0 (system down, data loss): respond in 15 minutes, 24/7. P1 (blocking a paying customer): respond within 2 hours during business hours. P2 (general question, non-urgent): respond within 1 business day. Start every response with acknowledgment before troubleshooting.",
        tags: ["sla", "response-times"],
      },
      {
        title: "Support tone principles",
        category: "preference",
        content:
          "Always empathetic first. Start with 'I understand...' or 'That sounds frustrating...'. Take ownership — say 'I'll look into this', not 'you need to...'. No blame of the customer. Explain resolutions in plain language. End every ticket with 'Is there anything else I can help with?'",
        tags: ["tone", "empathy", "support"],
      },
      {
        title: "Bug escalation process",
        category: "procedure",
        content:
          "Customer reports a bug: (1) Reproduce in test env. (2) Check if known issue. (3) If reproducible and unknown: file ticket with repro steps, customer ID, and impact count. (4) If critical (data loss or blocking): escalate to on-call engineer immediately. (5) Update customer within 1 hour.",
        tags: ["bugs", "escalation", "process"],
      },
      {
        title: "Refund policy",
        category: "policy",
        content:
          "Full refund within 30 days, no questions asked. Pro-rated refund after 30 days only if we caused the issue (bug, outage, feature removal). No refund for 'changed my mind' after 30 days. Refunds processed within 5 business days. All refunds logged.",
        tags: ["refund", "policy"],
      },
      {
        title: "Common issue resolution guide",
        category: "reference",
        content:
          "Top 5 issues: (1) Login issues → reset password flow, check SSO config. (2) Billing discrepancy → pull invoice, compare to plan. (3) Feature not working → check permissions and plan tier. (4) Data export → walk through export page. (5) Integration broken → check API key expiry and webhook logs.",
        tags: ["faq", "troubleshooting"],
      },
      {
        title: "Proactive customer outreach",
        category: "procedure",
        content:
          "Check in with customers who haven't logged in for 14 days. Send a personal email to users who hit an error 3+ times. Review NPS detractors within 48 hours. Quarterly business reviews for annual plan customers.",
        tags: ["proactive", "retention", "churn-prevention"],
      },
      {
        title: "Knowledge base maintenance",
        category: "procedure",
        content:
          "Any question answered 3+ times becomes a help article. Articles reviewed quarterly for accuracy. New features must include a help article draft before launch. Screenshots updated within 1 week of UI changes.",
        tags: ["knowledge-base", "documentation"],
      },
      {
        title: "Product feedback escalation",
        category: "procedure",
        content:
          "Escalate to product when: (1) same feature request from 3+ different customers, (2) customer blocked from a core use case, (3) customer about to churn because of a gap. Escalation format: customer name + ARR + specific quote + frequency. Log in product feedback tracker.",
        tags: ["escalation", "product-feedback"],
      },
    ],
  },

  // ── 6. Design ─────────────────────────────────────────────────────────────
  {
    id: "design",
    name: "Design",
    description: "Design system, accessibility baseline, review process, and UX standards.",
    functionType: "design",
    items: [
      {
        title: "Design system usage",
        category: "policy",
        content:
          "All production UI must use components from the design system. Do not create one-off components without first checking if one exists or if the existing one can be extended. New components require: a usage example, props documentation, and a mobile variant.",
        tags: ["design-system", "components"],
      },
      {
        title: "Design review process",
        category: "procedure",
        content:
          "All screens require a review before engineering handoff: (1) self-review against design checklist, (2) founder review for new features, (3) async review in Figma with 48-hour turnaround. Share with 'Ready for Review' status. Engineering starts after approval.",
        tags: ["review", "process", "handoff"],
      },
      {
        title: "Accessibility baseline",
        category: "policy",
        content:
          "WCAG AA compliance minimum. Required: 4.5:1 contrast ratio for text, keyboard navigability for all interactive elements, alt text on all images, visible focus indicators, no color as the only signal. Run axe-core before every major release.",
        tags: ["accessibility", "wcag", "standards"],
      },
      {
        title: "Mobile-first approach",
        category: "preference",
        content:
          "Design mobile (375px wide) first, then expand to desktop. Every feature must be usable on mobile before launch. Test on real iOS and Android devices — not just browser emulation. Touch targets minimum 44×44px.",
        tags: ["mobile", "responsive"],
      },
      {
        title: "Visual hierarchy principles",
        category: "reference",
        content:
          "One primary CTA per screen. Typography: 4 sizes max per page. White space is intentional — crowding signals unclear product thinking. Data-heavy screens get a summary card at top. Color: 1 primary, 1 secondary, system colors for state (error/success/warning).",
        tags: ["visual-hierarchy", "ui", "principles"],
      },
      {
        title: "User testing expectations",
        category: "preference",
        content:
          "Test with 5 real users before finalizing a complex flow. Guerrilla testing acceptable for low-risk changes. Always observe task completion — don't ask 'do you like it?'. Ask 'what would you do next?'. Summarize findings in a 1-page doc in the design folder.",
        tags: ["user-testing", "research", "validation"],
      },
      {
        title: "Figma file organization",
        category: "procedure",
        content:
          "1 file per feature area. Pages: Cover, Components, Screens (by flow). Layers named descriptively (not 'Rectangle 34'). Archive explorations in a 'Graveyard' page — don't delete. Use Figma comments for feedback, not Slack (keeps context with the design).",
        tags: ["figma", "organization"],
      },
      {
        title: "Animation standards",
        category: "reference",
        content:
          "Use animation sparingly — only to guide attention or communicate state changes. Durations: micro-interactions 100–200ms, page transitions 200–300ms. Never animate on critical paths (form submit, data save). Respect prefers-reduced-motion system setting.",
        tags: ["animation", "motion", "standards"],
      },
    ],
  },

  // ── 7. Finance ────────────────────────────────────────────────────────────
  {
    id: "finance",
    name: "Finance",
    description: "Financial controls, expense policy, reporting cadence, and fraud prevention.",
    functionType: "finance",
    items: [
      {
        title: "Expense approval policy",
        category: "policy",
        content:
          "Under $200: no pre-approval needed, submit with receipt within 7 days. $200–$1,000: manager approval before purchase. Over $1,000: founder approval required. Subscriptions over $100/month require quarterly review. No reimbursements without a receipt.",
        tags: ["expenses", "policy", "approval"],
      },
      {
        title: "Monthly close process",
        category: "procedure",
        content:
          "By the 5th of each month: (1) reconcile all accounts, (2) categorize all transactions, (3) review AP/AR aging, (4) generate P&L and cash flow statement, (5) compare actuals to budget, (6) flag any variances over 10%. Close complete when all accounts reconcile.",
        tags: ["month-end", "close", "process"],
      },
      {
        title: "Runway monitoring",
        category: "procedure",
        content:
          "Review cash runway weekly: current cash ÷ average monthly burn = months of runway. Alert threshold: 9 months (orange), 6 months (red). At 6 months: fundraise or profitability conversation is non-negotiable. Runway shared with investors monthly.",
        tags: ["runway", "cash", "monitoring"],
      },
      {
        title: "Budget categories",
        category: "reference",
        content:
          "Spending categories: (1) People (salaries, contractors), (2) Infrastructure (hosting, SaaS tools), (3) Marketing (ads, content, events), (4) Sales (commissions, CRM), (5) R&D (tools, experiments), (6) G&A (legal, accounting, admin). Budget reviewed quarterly.",
        tags: ["budget", "categories", "spending"],
      },
      {
        title: "Contractor payment process",
        category: "procedure",
        content:
          "Collect W-9 (US) or W-8BEN (international) before first payment. Net-15 payment terms standard. All contracts signed before work begins. Issue 1099-NEC for US contractors paid over $600/year. Contractor agreements reviewed by legal before signing.",
        tags: ["contractors", "payments", "compliance"],
      },
      {
        title: "Revenue recognition",
        category: "reference",
        content:
          "SaaS subscriptions: recognize monthly over the subscription term (not on payment date). Annual prepay: deferred revenue, recognized monthly. One-time setup fees: recognize on service delivery date. Refunds: reduce revenue in the month issued. Follow ASC 606.",
        tags: ["revenue", "recognition", "accounting"],
      },
      {
        title: "Tax compliance deadlines",
        category: "reference",
        content:
          "US estimated taxes: Q1 April 15, Q2 June 15, Q3 September 15, Q4 January 15. Annual return: April 15 (October 15 with extension). Review sales tax nexus quarterly as revenue and headcount grow. All payroll taxes filed on schedule — penalties compound.",
        tags: ["tax", "compliance", "deadlines"],
      },
      {
        title: "Fraud prevention controls",
        category: "policy",
        content:
          "Two-factor authentication on all financial accounts. No wire transfers initiated by email alone — verify by phone for any wire over $5K. ACH and wire limits set on all accounts. Bank statements reviewed by founder monthly. Unrecognized transactions reported to bank within 48 hours.",
        tags: ["fraud", "security", "financial-controls"],
      },
    ],
  },

  // ── 8. Operations ─────────────────────────────────────────────────────────
  {
    id: "operations",
    name: "Operations",
    description: "Tool approval, vendor management, incident communication, and process documentation.",
    functionType: "operations",
    items: [
      {
        title: "SaaS tool approval policy",
        category: "policy",
        content:
          "Any new SaaS tool requires: (1) a clear use case, (2) estimated cost over 12 months, (3) data privacy review (does it access customer data?), (4) founder approval for any tool over $50/month. Tools under $50/month can be self-approved by team leads. All tools inventoried in the master tools list.",
        tags: ["tools", "saas", "approval"],
      },
      {
        title: "Vendor selection process",
        category: "procedure",
        content:
          "For any vendor contract over $10K/year: (1) document requirements, (2) evaluate 2–3 alternatives, (3) check 2 references, (4) legal review of contract, (5) founder approval. For standard vendors: choose based on review sites + trial. Document the selection rationale.",
        tags: ["vendors", "procurement"],
      },
      {
        title: "Runbook documentation standard",
        category: "preference",
        content:
          "Every recurring operational process needs a runbook: title, owner, trigger, step-by-step instructions with screenshots, common errors + resolutions. Runbooks live in the ops wiki. Updated when the process changes. 'If you did it twice, document it.'",
        tags: ["runbooks", "documentation", "process"],
      },
      {
        title: "Incident communication",
        category: "procedure",
        content:
          "Incident detected: (1) post in #incidents within 5 minutes with severity + what we know, (2) update every 30 minutes, (3) customer-facing status page updated within 15 minutes for P0. Post-incident: publish a brief report within 48 hours. Focus on systems, not people.",
        tags: ["incidents", "communication", "process"],
      },
      {
        title: "New hire onboarding",
        category: "procedure",
        content:
          "Day 1: all accounts set up before they start (email, Slack, GitHub, cloud access). Week 1: intro meetings with all department leads. First 2 weeks: first small task completed and shipped. 30-day check-in with manager. 90-day check-in with founder. Buddy assigned from day 1.",
        tags: ["onboarding", "new-hires"],
      },
      {
        title: "Offboarding process",
        category: "procedure",
        content:
          "Last day: revoke all system access (email, Slack, GitHub, cloud, SaaS tools). Transfer knowledge documents. Return company equipment. Data retention: email archived 90 days. Access audit completed and documented within 24 hours.",
        tags: ["offboarding", "security", "process"],
      },
      {
        title: "Business continuity plan",
        category: "reference",
        content:
          "Critical systems and backups: database (daily snapshots, tested monthly), code repository (GitHub, mirrored). If founder is unavailable: designated backup has authority for P0 decisions under $5K. Document all critical vendor contacts and account credentials in the secure vault.",
        tags: ["business-continuity", "backup", "risk"],
      },
      {
        title: "Meeting standards",
        category: "preference",
        content:
          "Every meeting needs: a clear owner, an agenda sent 24 hours before, and a decision or action item as output. No meeting recurring without a quarterly review of whether it's still needed. Default: 30 minutes. Internal syncs capped at 25 minutes — leave 5 for action recording.",
        tags: ["meetings", "efficiency", "standards"],
      },
    ],
  },

  // ── 9. People & HR ────────────────────────────────────────────────────────
  {
    id: "people",
    name: "People & HR",
    description: "Hiring criteria, performance feedback, compensation philosophy, and leave policies.",
    functionType: "people_ops",
    items: [
      {
        title: "Hiring decision criteria",
        category: "procedure",
        content:
          "Hire for: (1) ability to own problems end-to-end, (2) communication skills at least as strong as technical skills, (3) curiosity. Interview process: screening call, take-home assignment, skills + culture interview, 2 reference checks. Decision within 1 week of final interview.",
        tags: ["hiring", "criteria", "process"],
      },
      {
        title: "Performance feedback cadence",
        category: "procedure",
        content:
          "Continuous feedback in weekly 1:1s. Formal reviews: quarterly (30 min, structured). Annual review: 60 min retrospective + goal-setting. Feedback format: (1) what's going well, (2) one area to grow, (3) what support do you need from me? No surprise negative feedback.",
        tags: ["performance", "feedback", "1:1s"],
      },
      {
        title: "Compensation philosophy",
        category: "reference",
        content:
          "Compensation bands based on market data (refreshed annually). Target: 50th–75th percentile for cash, above median on equity. No gender or tenure-based pay gaps — audit annually. Salary ranges shared with new offers. Performance increases at annual review, not on request.",
        tags: ["compensation", "salary", "philosophy"],
      },
      {
        title: "Remote work policy",
        category: "policy",
        content:
          "Fully remote by default. Core overlap hours: 10am–3pm in the team's primary timezone. Async-first: document decisions in writing. Required in-person: annual company retreat (covered by company). Ergonomic stipend: $500 one-time for home office setup.",
        tags: ["remote", "work-policy", "async"],
      },
      {
        title: "PTO and leave policy",
        category: "reference",
        content:
          "PTO: 20 days/year. Additional: 10 public holidays. Sick leave: unlimited (no tracking). Parental leave: 12 weeks fully paid. Sabbatical after 3 years (4 weeks). PTO requests submitted 2 weeks in advance for over 3 consecutive days. No PTO payout at year-end.",
        tags: ["pto", "leave", "policy"],
      },
      {
        title: "Promotion criteria",
        category: "reference",
        content:
          "Promotions based on sustained performance at the next level for at least 1 quarter — not time in role. Criteria: (1) expanded scope of impact, (2) demonstrating next-level skills, (3) peer recognition. Promotions effective next fiscal quarter. No retroactive promotions.",
        tags: ["promotions", "career", "growth"],
      },
      {
        title: "Psychological safety standards",
        category: "preference",
        content:
          "We address issues directly, not through proxies. Disagreement is encouraged in the room; venting outside is not. Anonymous feedback channel available at all times. Discrimination or harassment: zero tolerance, immediate investigation. All HR issues handled confidentially.",
        tags: ["culture", "safety", "feedback"],
      },
      {
        title: "Termination process",
        category: "procedure",
        content:
          "Performance-based: document 3 specific incidents, provide written warning with 30-day improvement plan, review at end of 30 days. Immediate termination with cause: requires documented policy violation. All terminations reviewed by founder. Notice: 2 weeks standard.",
        tags: ["termination", "process", "hr"],
      },
    ],
  },

  // ── 10. Legal ─────────────────────────────────────────────────────────────
  {
    id: "legal",
    name: "Legal & Compliance",
    description: "Contract standards, data privacy, IP assignment, and regulatory compliance.",
    functionType: "legal",
    items: [
      {
        title: "Contract review policy",
        category: "policy",
        content:
          "Any contract over $5K annual value requires legal review before signature. Under $5K: founder can sign after reviewing for payment terms, liability cap, IP ownership, and termination rights. Never sign anything with unlimited liability. Auto-renewals flagged and calendared 60 days before renewal.",
        tags: ["contracts", "legal-review", "policy"],
      },
      {
        title: "Data privacy baseline (GDPR/CCPA)",
        category: "policy",
        content:
          "Process only data we need. Privacy policy updated within 30 days of any new data processing. Customer data deletion requests fulfilled within 30 days. Data processing agreements (DPAs) required with all vendors who process customer data. Annual privacy review. Breach notification plan documented.",
        tags: ["privacy", "gdpr", "ccpa", "compliance"],
      },
      {
        title: "IP assignment policy",
        category: "policy",
        content:
          "All work created by employees and contractors in the scope of their engagement is company IP. This must be documented in every employment and contractor agreement before work begins. Employees must disclose any personal IP used in company work before using it.",
        tags: ["ip", "intellectual-property", "policy"],
      },
      {
        title: "Terms of service requirements",
        category: "reference",
        content:
          "Our ToS must include: limitation of liability, disclaimer of warranties, governing law, dispute resolution (arbitration clause), acceptable use policy, and termination rights. Reviewed by legal annually or when the business model changes. Link accessible from every page.",
        tags: ["terms-of-service", "legal"],
      },
      {
        title: "Worker classification policy",
        category: "policy",
        content:
          "Misclassifying employees as contractors is a legal and tax liability. Classify as employee if: regular hours, company equipment, single client, or follows company processes. When in doubt, classify as employee. All classifications documented. Review annually with counsel.",
        tags: ["employment", "contractors", "classification"],
      },
      {
        title: "Annual compliance checklist",
        category: "reference",
        content:
          "Annual: (1) Secretary of State filing (if required), (2) beneficial ownership report, (3) tax filings (federal + state), (4) payroll compliance review, (5) privacy policy update, (6) insurance renewal, (7) industry-specific regulations. Use outside counsel for first filing of any new requirement.",
        tags: ["compliance", "regulatory", "annual"],
      },
      {
        title: "Equity and cap table management",
        category: "reference",
        content:
          "Cap table maintained in Carta or equivalent. Option grants require board approval before informing the employee. 409A valuation refreshed before any new grants or fundraise. All equity transactions documented. Employee equity summary provided annually to all holders.",
        tags: ["equity", "cap-table", "options"],
      },
      {
        title: "Incident legal response",
        category: "procedure",
        content:
          "Data breach: (1) contain the breach, (2) notify legal counsel within 24 hours, (3) document what was accessed + time window, (4) prepare notifications per GDPR/CCPA timelines (72h for GDPR). Lawsuit or demand letter: do not respond without legal review. Preserve all relevant records immediately.",
        tags: ["incident", "legal-response", "breach"],
      },
    ],
  },

  // ── 11. Data & Analytics ──────────────────────────────────────────────────
  {
    id: "data",
    name: "Data & Analytics",
    description: "Data governance, metrics definitions, reporting cadence, and A/B testing protocol.",
    functionType: "data_analytics",
    items: [
      {
        title: "Data governance policy",
        category: "policy",
        content:
          "All production data changes must go through the data team review. No direct production database queries by non-data roles without a data team member present. All new data sources documented in the data catalog within 1 week of ingestion. PII masked in all non-production environments.",
        tags: ["data-governance", "policy", "pii"],
      },
      {
        title: "Metrics definition standard",
        category: "procedure",
        content:
          "Every metric must have: (1) a plain-English definition, (2) the SQL/calculation logic, (3) the owner, (4) the refresh cadence. New metrics reviewed in a weekly sync before being added to dashboards. Metrics not reproducible exactly are not permitted in board reporting.",
        tags: ["metrics", "definitions", "standards"],
      },
      {
        title: "Dashboard reliability standards",
        category: "policy",
        content:
          "Production dashboards must have: data freshness indicator, source documentation, and a last-verified date. Dashboards not refreshed in 30 days removed from production. Any discrepancy over 5% against source data triggers an immediate audit. Critical dashboards reviewed before any board meeting.",
        tags: ["dashboards", "reliability", "data-quality"],
      },
      {
        title: "Data pipeline standards",
        category: "preference",
        content:
          "Pipelines must be: modular (one source → one destination per job), idempotent (safe to re-run), and observable (failure alerts within 15 minutes). All pipeline changes tested in staging first. Documentation updated same day as code changes. dbt or equivalent for all transformations.",
        tags: ["pipelines", "etl", "standards"],
      },
      {
        title: "A/B testing protocol",
        category: "procedure",
        content:
          "Before starting: document hypothesis, success metric, sample size calculation, and minimum run time (at least 1 week or 95% statistical significance). After: report includes lift, confidence interval, sample size, and recommendation. No winner declared before minimum run time.",
        tags: ["ab-testing", "experiments", "protocol"],
      },
      {
        title: "Data access control",
        category: "policy",
        content:
          "Access levels: (1) Aggregated reports only (all employees), (2) Row-level data (data team + role-specific), (3) PII access (data team + legal + founder only). Access requests require a business justification. Access reviewed quarterly — remove when no longer needed. No shared database credentials.",
        tags: ["access-control", "data-security"],
      },
      {
        title: "Reporting cadence",
        category: "reference",
        content:
          "Daily: revenue, signups, active users (automated). Weekly: full funnel metrics, churn, product engagement (data team sends Monday AM). Monthly: board-level report with trend analysis and commentary (due by 10th of month). Quarterly: deep-dive on strategic metrics for OKR review.",
        tags: ["reporting", "cadence", "dashboards"],
      },
      {
        title: "Data retention policy",
        category: "policy",
        content:
          "Raw event data: retained 2 years. Aggregated metrics: retained indefinitely. PII: retained only as long as legally required or customer relationship is active. User-deleted data: removed within 30 days from all systems including backups. Schedule reviewed annually with legal.",
        tags: ["retention", "data-management", "compliance"],
      },
    ],
  },
];

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * List all available starter templates (summary only — same data as full
 * since the items array is small and needed for the preview dialog).
 */
export function listStarterTemplates(): MemoryStarterTemplate[] {
  return MEMORY_STARTER_TEMPLATES;
}

const TEMPLATE_FUNCTION_TYPE_ALIASES: Record<string, string[]> = {
  software_development: ["software_development", "product_management"],
  marketing: ["marketing", "sales", "design"],
  finance: ["finance"],
  support: ["support", "customer_support"],
  hr: ["hr", "people_ops"],
  legal: ["legal"],
  research: ["research", "data_analytics"],
  operations: ["operations"],
  general: ["general", "custom"],
  custom: ["general", "custom"],
};

export function getStarterTemplatesForFunctionType(
  functionType: string | null | undefined,
): MemoryStarterTemplate[] {
  if (!functionType) return [];
  const aliases = TEMPLATE_FUNCTION_TYPE_ALIASES[functionType] ?? [functionType];
  return MEMORY_STARTER_TEMPLATES.filter((template) =>
    aliases.includes(template.functionType),
  );
}

export interface ApplyStarterTemplateResult {
  count: number;
  alreadyApplied: boolean;
}

/**
 * Bulk-insert all items from a starter template into the company's memory.
 *
 * Items land as:
 *   - status: "approved" (immediately visible to agents)
 *   - source: "template"
 *   - layer: "domain"
 *   - sourceContext: "template:<templateId>" (idempotency key)
 *   - departmentId: opts.departmentId ?? null
 *
 * Re-applying the same template to the same company is a no-op:
 * if any item with sourceContext = "template:<templateId>" already exists
 * in this company, return { count: 0, alreadyApplied: true }.
 */
export async function applyStarterTemplate(
  db: Db,
  companyId: string,
  templateId: string,
  opts: { departmentId?: string | null } = {},
): Promise<ApplyStarterTemplateResult> {
  const template = MEMORY_STARTER_TEMPLATES.find((t) => t.id === templateId);
  if (!template) {
    throw new Error(`Unknown starter template: ${templateId}`);
  }

  const sourceContextKey = `template:${templateId}`;

  // Idempotency guard
  const existingCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.companyId, companyId),
        sql`${memoryItems.sourceContext} = ${sourceContextKey}`,
      ),
    )
    .then((rows) => Number(rows[0]?.count ?? 0));

  if (existingCount > 0) {
    log.info({ companyId, templateId }, "Starter template already applied — skipping");
    return { count: 0, alreadyApplied: true };
  }

  const now = new Date();
  const rows = template.items.map((item) => ({
    companyId,
    title: item.title,
    content: item.content,
    category: item.category,
    status: "approved" as const,
    source: "template" as const,
    sourceContext: sourceContextKey,
    layer: "domain" as const,
    tags: item.tags ?? [],
    departmentId: opts.departmentId ?? null,
    createdBy: "founder",
    priority: 0,
    visibility: "scoped" as const,
    createdAt: now,
    updatedAt: now,
  }));

  await db.insert(memoryItems).values(rows);

  log.info({ companyId, templateId, count: rows.length }, "Applied memory starter template");
  return { count: rows.length, alreadyApplied: false };
}
