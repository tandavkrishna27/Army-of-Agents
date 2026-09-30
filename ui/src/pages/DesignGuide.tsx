import { useState } from "react";
import { ComposerFrame } from "@/components/composer/ComposerFrame";
import { ComposerAttachmentCard } from "@/components/composer/ComposerAttachmentCard";
import {
  Activity,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  Cloud,
  Command as CommandIcon,
  DollarSign,
  Hexagon,
  History,
  Inbox,
  KeyRound,
  LayoutDashboard,
  ListTodo,
  Mail,
  Plus,
  Search,
  Settings,
  Target,
  Trash2,
  Upload,
  User,
  Zap,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { PriorityIcon } from "@/components/PriorityIcon";
import { agentStatusDot, agentStatusDotDefault } from "@/lib/status-colors";
import { EntityRow } from "@/components/EntityRow";
import { SecretBindingPicker, type SecretBindingPickerValue } from "@/components/SecretBindingPicker";
import { EmptyState } from "@/components/EmptyState";
import { MetricCard } from "@/components/MetricCard";
import { FilterBar, type FilterValue } from "@/components/FilterBar";
import { InlineEditor } from "@/components/InlineEditor";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Identity } from "@/components/Identity";
import { UserMenu } from "@/components/UserMenu";
import {
  ReportsToSelect,
  type UnifiedOrgNode,
} from "@/components/team/ReportsToSelect";
import { RoutineVariablesEditor } from "@/components/routines/RoutineVariablesEditor";
import { RoutineRunDialog } from "@/components/routines/RoutineRunDialog";
import { PrivacyTab } from "@/components/settings/PrivacyTab";
import { BackupsTab } from "@/components/settings/BackupsTab";
import { HeartbeatsTabView } from "@/components/settings/HeartbeatsTab";
import { BudgetPolicyCard } from "@/components/finance/BudgetPolicyCard";
import { BudgetIncidentCard } from "@/components/finance/BudgetIncidentCard";
import { QuotaBar } from "@/components/finance/QuotaBar";
import { ProviderQuotaCard } from "@/components/finance/ProviderQuotaCard";
import { FinanceBillerCard } from "@/components/finance/FinanceBillerCard";
import { FinanceKindCard } from "@/components/finance/FinanceKindCard";
import { FinanceTimelineCard } from "@/components/finance/FinanceTimelineCard";
import { AccountingModelCard } from "@/components/finance/AccountingModelCard";
import {
  ClaudeSubscriptionPanel,
  type SubscriptionRollup,
} from "@/components/finance/ClaudeSubscriptionPanel";
import { CodexSubscriptionPanel } from "@/components/finance/CodexSubscriptionPanel";
import type { ProviderQuotaWindow } from "@/api/quotas";
import type {
  FinanceBillerRow,
  FinanceKindRow,
  FinanceEvent,
} from "@/api/finance";
import type { CostByModelRow } from "@/api/costs";
import type { BudgetPolicySummary, BudgetIncident, CompanySecret } from "@armyofagents/shared";
import { CompanyExport as CompanyExportPage } from "@/pages/CompanyExport";
import { CompanyImport as CompanyImportPage } from "@/pages/CompanyImport";
import { FeedbackThumbs } from "@/components/FeedbackThumbs";
import { FeedbackConsentModal } from "@/components/FeedbackConsentModal";

/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        {title}
      </h3>
      <Separator />
      {children}
    </section>
  );
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">{title}</h4>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Color swatch                                                       */
/* ------------------------------------------------------------------ */

function Swatch({ name, cssVar }: { name: string; cssVar: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-8 w-8 rounded-md border border-border shrink-0"
        style={{ backgroundColor: `var(${cssVar})` }}
      />
      <div>
        <p className="text-xs font-mono">{cssVar}</p>
        <p className="text-xs text-muted-foreground">{name}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function DesignGuide() {
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("medium");
  const [selectValue, setSelectValue] = useState("in_progress");
  const [menuChecked, setMenuChecked] = useState(true);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);
  const [inlineText, setInlineText] = useState("Click to edit this text");
  const [inlineTitle, setInlineTitle] = useState("Editable Title");
  const [inlineDesc, setInlineDesc] = useState(
    "This is an editable description. Click to edit it — the textarea auto-sizes to fit the content without layout shift."
  );
  const [secretBinding, setSecretBinding] = useState<SecretBindingPickerValue>(null);
  const [filters, setFilters] = useState<FilterValue[]>([
    { key: "status", label: "Status", value: "Active" },
    { key: "priority", label: "Priority", value: "High" },
  ]);
  const demoSecrets: CompanySecret[] = [
    {
      id: "11111111-1111-1111-1111-111111111111",
      companyId: "demo-company",
      name: "OpenAI API key",
      key: "OPENAI_API_KEY",
      status: "active",
      managedMode: "aoa_managed",
      provider: "local_encrypted",
      providerConfigId: null,
      providerMetadata: null,
      externalRef: null,
      latestVersion: 3,
      description: "Primary LLM runtime credential",
      lastResolvedAt: null,
      lastRotatedAt: null,
      deletedAt: null,
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      companyId: "demo-company",
      name: "Very long production database password used by routine workers",
      key: "PRODUCTION_DATABASE_PASSWORD_WITH_LONG_NAME",
      status: "active",
      managedMode: "external_reference",
      provider: "aws_secrets_manager",
      providerConfigId: "33333333-3333-3333-3333-333333333333",
      providerMetadata: null,
      externalRef: "arn:aws:secretsmanager:us-east-1:111111111111:secret:aoa/prod/db",
      latestVersion: 8,
      description: null,
      lastResolvedAt: null,
      lastRotatedAt: null,
      deletedAt: null,
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  return (
    <div className="space-y-10 max-w-4xl">
      {/* Page header */}
      <div>
        <h2 className="text-xl font-bold">Design Guide</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Every component, style, and pattern used across AoA.
        </p>
      </div>

      {/* ============================================================ */}
      {/*  COVERAGE                                                     */}
      {/* ============================================================ */}
      <Section title="Component Coverage">
        <p className="text-sm text-muted-foreground">
          This page should be updated when new UI primitives or app-level patterns ship.
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title="UI primitives">
            <div className="flex flex-wrap gap-2">
              {[
                "avatar", "badge", "breadcrumb", "button", "card", "checkbox", "collapsible",
                "command", "dialog", "dropdown-menu", "input", "label", "popover", "scroll-area",
                "select", "separator", "sheet", "skeleton", "tabs", "textarea", "tooltip",
              ].map((name) => (
                <Badge key={name} variant="outline" className="font-mono text-[10px]">
                  {name}
                </Badge>
              ))}
            </div>
          </SubSection>
          <SubSection title="App components">
            <div className="flex flex-wrap gap-2">
              {[
                "StatusBadge", "StatusIcon", "PriorityIcon", "EntityRow", "EmptyState", "MetricCard",
                "FilterBar", "InlineEditor", "PageSkeleton", "Identity", "UserMenu", "CommentThread", "MarkdownEditor",
                "PropertiesPanel", "Sidebar", "CommandPalette", "FeedbackThumbs", "FeedbackConsentModal",
              ].map((name) => (
                <Badge key={name} variant="ghost" className="font-mono text-[10px]">
                  {name}
                </Badge>
              ))}
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COLORS                                                       */}
      {/* ============================================================ */}
      <Section title="Colors">
        <SubSection title="Core">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Background" cssVar="--background" />
            <Swatch name="Foreground" cssVar="--foreground" />
            <Swatch name="Card" cssVar="--card" />
            <Swatch name="Primary" cssVar="--primary" />
            <Swatch name="Primary foreground" cssVar="--primary-foreground" />
            <Swatch name="Secondary" cssVar="--secondary" />
            <Swatch name="Muted" cssVar="--muted" />
            <Swatch name="Muted foreground" cssVar="--muted-foreground" />
            <Swatch name="Accent" cssVar="--accent" />
            <Swatch name="Destructive" cssVar="--destructive" />
            <Swatch name="Border" cssVar="--border" />
            <Swatch name="Ring" cssVar="--ring" />
          </div>
        </SubSection>

        <SubSection title="Sidebar">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Sidebar" cssVar="--sidebar" />
            <Swatch name="Sidebar border" cssVar="--sidebar-border" />
          </div>
        </SubSection>

        <SubSection title="Chart">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Chart 1" cssVar="--chart-1" />
            <Swatch name="Chart 2" cssVar="--chart-2" />
            <Swatch name="Chart 3" cssVar="--chart-3" />
            <Swatch name="Chart 4" cssVar="--chart-4" />
            <Swatch name="Chart 5" cssVar="--chart-5" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TYPOGRAPHY                                                   */}
      {/* ============================================================ */}
      <Section title="Typography">
        <div className="space-y-3">
          <h2 className="text-xl font-bold">Page Title — text-xl font-bold</h2>
          <h2 className="text-lg font-semibold">Section Title — text-lg font-semibold</h2>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Section Heading — text-sm font-semibold uppercase tracking-wide
          </h3>
          <p className="text-sm font-medium">Card Title — text-sm font-medium</p>
          <p className="text-sm font-semibold">Card Title Alt — text-sm font-semibold</p>
          <p className="text-sm">Body text — text-sm</p>
          <p className="text-sm text-muted-foreground">
            Muted description — text-sm text-muted-foreground
          </p>
          <p className="text-xs text-muted-foreground">
            Tiny label — text-xs text-muted-foreground
          </p>
          <p className="text-sm font-mono text-muted-foreground">
            Mono identifier — text-sm font-mono text-muted-foreground
          </p>
          <p className="text-2xl font-bold">Large stat — text-2xl font-bold</p>
          <p className="font-mono text-xs">Log/code text — font-mono text-xs</p>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SPACING & RADIUS                                             */}
      {/* ============================================================ */}
      <Section title="Radius">
        <div className="flex items-end gap-4 flex-wrap">
          {[
            ["sm", "var(--radius-sm)"],
            ["md", "var(--radius-md)"],
            ["lg", "var(--radius-lg)"],
            ["xl", "var(--radius-xl)"],
            ["full", "9999px"],
          ].map(([label, radius]) => (
            <div key={label} className="flex flex-col items-center gap-1">
              <div
                className="h-12 w-12 bg-primary"
                style={{ borderRadius: radius }}
              />
              <span className="text-xs text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BUTTONS                                                      */}
      {/* ============================================================ */}
      <Section title="Buttons">
        <SubSection title="Variants">
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="default">Default</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
          </div>
        </SubSection>

        <SubSection title="Sizes">
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="xs">Extra Small</Button>
            <Button size="sm">Small</Button>
            <Button size="default">Default</Button>
            <Button size="lg">Large</Button>
          </div>
        </SubSection>

        <SubSection title="Icon buttons">
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" size="icon-xs"><Search /></Button>
            <Button variant="ghost" size="icon-sm"><Search /></Button>
            <Button variant="outline" size="icon"><Search /></Button>
            <Button variant="outline" size="icon-lg"><Search /></Button>
          </div>
        </SubSection>

        <SubSection title="With icons">
          <div className="flex items-center gap-2 flex-wrap">
            <Button><Plus /> New Task</Button>
            <Button variant="outline"><Upload /> Upload</Button>
            <Button variant="destructive"><Trash2 /> Delete</Button>
            <Button size="sm"><Plus /> Add</Button>
          </div>
        </SubSection>

        <SubSection title="States">
          <div className="flex items-center gap-2 flex-wrap">
            <Button disabled>Disabled</Button>
            <Button variant="outline" disabled>Disabled Outline</Button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  BADGES                                                       */}
      {/* ============================================================ */}
      <Section title="Badges">
        <SubSection title="Variants">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="default">Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge variant="ghost">Ghost</Badge>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  STATUS BADGES & ICONS                                        */}
      {/* ============================================================ */}
      <Section title="Status System">
        <SubSection title="StatusBadge (all statuses)">
          <div className="flex items-center gap-2 flex-wrap">
            {[
              "active", "running", "paused", "idle", "archived", "planned",
              "achieved", "completed", "failed", "timed_out", "succeeded", "error",
              "pending_approval", "backlog", "todo", "in_progress", "in_review", "blocked",
              "done", "terminated", "cancelled", "pending", "revision_requested",
              "approved", "rejected",
            ].map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </div>
        </SubSection>

        <SubSection title="StatusIcon (interactive)">
          <div className="flex items-center gap-3 flex-wrap">
            {["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"].map(
              (s) => (
                <div key={s} className="flex items-center gap-1.5">
                  <StatusIcon status={s} />
                  <span className="text-xs text-muted-foreground">{s}</span>
                </div>
              )
            )}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <StatusIcon status={status} onChange={setStatus} />
            <span className="text-sm">Click the icon to change status (current: {status})</span>
          </div>
        </SubSection>

        <SubSection title="PriorityIcon (interactive)">
          <div className="flex items-center gap-3 flex-wrap">
            {["critical", "high", "medium", "low"].map((p) => (
              <div key={p} className="flex items-center gap-1.5">
                <PriorityIcon priority={p} />
                <span className="text-xs text-muted-foreground">{p}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <PriorityIcon priority={priority} onChange={setPriority} />
            <span className="text-sm">Click the icon to change (current: {priority})</span>
          </div>
        </SubSection>

        <SubSection title="Agent status dots">
          <div className="flex items-center gap-4 flex-wrap">
            {(["running", "active", "paused", "error", "archived"] as const).map((label) => (
              <div key={label} className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className={`inline-flex h-full w-full rounded-full ${agentStatusDot[label] ?? agentStatusDotDefault}`} />
                </span>
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </SubSection>

        <SubSection title="Run invocation badges">
          <div className="flex items-center gap-2 flex-wrap">
            {[
              ["timer", "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"],
              ["assignment", "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"],
              ["on_demand", "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300"],
              ["automation", "bg-muted text-muted-foreground"],
            ].map(([label, cls]) => (
              <span key={label} className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
                {label}
              </span>
            ))}
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  FORM ELEMENTS                                                */}
      {/* ============================================================ */}
      <Section title="Form Elements">
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title="Input">
            <Input placeholder="Default input" />
            <Input placeholder="Disabled input" disabled className="mt-2" />
          </SubSection>

          <SubSection title="Textarea">
            <Textarea placeholder="Write something..." />
          </SubSection>

          <SubSection title="Checkbox & Label">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox id="check1" defaultChecked />
                <Label htmlFor="check1">Checked item</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check2" />
                <Label htmlFor="check2">Unchecked item</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check3" disabled />
                <Label htmlFor="check3">Disabled item</Label>
              </div>
            </div>
          </SubSection>

          <SubSection title="Inline Editor">
            <div className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Title (single-line)</p>
                <InlineEditor
                  value={inlineTitle}
                  onSave={setInlineTitle}
                  as="h2"
                  className="text-xl font-bold"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Body text (single-line)</p>
                <InlineEditor
                  value={inlineText}
                  onSave={setInlineText}
                  as="p"
                  className="text-sm"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Description (multiline, auto-sizing)</p>
                <InlineEditor
                  value={inlineDesc}
                  onSave={setInlineDesc}
                  as="p"
                  className="text-sm text-muted-foreground"
                  placeholder="Add a description..."
                  multiline
                />
              </div>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SELECT                                                       */}
      {/* ============================================================ */}
      <Section title="Select">
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title="Default size">
            <Select value={selectValue} onValueChange={setSelectValue}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="backlog">Backlog</SelectItem>
                <SelectItem value="todo">Todo</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="in_review">In Review</SelectItem>
                <SelectItem value="done">Done</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Current value: {selectValue}</p>
          </SubSection>
          <SubSection title="Small trigger">
            <Select defaultValue="high">
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">Critical</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DROPDOWN MENU                                                */}
      {/* ============================================================ */}
      <Section title="Dropdown Menu">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Quick Actions
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem>
              <Check className="h-4 w-4" />
              Mark as done
              <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <BookOpen className="h-4 w-4" />
              Open docs
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={menuChecked}
              onCheckedChange={(value) => setMenuChecked(value === true)}
            >
              Watch issue
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem variant="destructive">
              <Trash2 className="h-4 w-4" />
              Delete issue
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      {/* ============================================================ */}
      {/*  POPOVER                                                      */}
      {/* ============================================================ */}
      <Section title="Popover">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">Open Popover</Button>
          </PopoverTrigger>
          <PopoverContent className="space-y-2">
            <p className="text-sm font-medium">Agent heartbeat</p>
            <p className="text-xs text-muted-foreground">
              Last run succeeded 24s ago. Next timer run in 9m.
            </p>
            <Button size="xs">Wake now</Button>
          </PopoverContent>
        </Popover>
      </Section>

      {/* ============================================================ */}
      {/*  COLLAPSIBLE                                                  */}
      {/* ============================================================ */}
      <Section title="Collapsible">
        <Collapsible open={collapsibleOpen} onOpenChange={setCollapsibleOpen} className="space-y-2">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">
              {collapsibleOpen ? "Hide" : "Show"} advanced filters
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="rounded-md border border-border p-3">
            <div className="space-y-2">
              <Label htmlFor="owner-filter">Owner</Label>
              <Input id="owner-filter" placeholder="Filter by agent name" />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Section>

      {/* ============================================================ */}
      {/*  SHEET                                                        */}
      {/* ============================================================ */}
      <Section title="Sheet">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm">Open Side Panel</Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>Task Properties</SheetTitle>
              <SheetDescription>Edit metadata without leaving the current page.</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4">
              <div className="space-y-1">
                <Label htmlFor="sheet-title">Title</Label>
                <Input id="sheet-title" defaultValue="Improve onboarding docs" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sheet-description">Description</Label>
                <Textarea id="sheet-description" defaultValue="Capture setup pitfalls and screenshots." />
              </div>
            </div>
            <SheetFooter>
              <Button variant="outline">Cancel</Button>
              <Button>Save</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Section>

      {/* ============================================================ */}
      {/*  SCROLL AREA                                                  */}
      {/* ============================================================ */}
      <Section title="Scroll Area">
        <ScrollArea className="h-36 rounded-md border border-border">
          <div className="space-y-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-sm">
                Heartbeat run #{i + 1}: completed successfully
              </div>
            ))}
          </div>
        </ScrollArea>
      </Section>

      {/* ============================================================ */}
      {/*  COMMAND                                                      */}
      {/* ============================================================ */}
      <Section title="Command (CMDK)">
        <div className="rounded-md border border-border">
          <Command>
            <CommandInput placeholder="Type a command or search..." />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup heading="Pages">
                <CommandItem>
                  <LayoutDashboard className="h-4 w-4" />
                  Dashboard
                </CommandItem>
                <CommandItem>
                  <CircleDot className="h-4 w-4" />
                  Tasks
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Actions">
                <CommandItem>
                  <CommandIcon className="h-4 w-4" />
                  Open command palette
                </CommandItem>
                <CommandItem>
                  <Plus className="h-4 w-4" />
                  Create new issue
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BREADCRUMB                                                   */}
      {/* ============================================================ */}
      <Section title="Breadcrumb">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">Projects</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">AoA</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Task List</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Section>

      {/* ============================================================ */}
      {/*  CARDS                                                        */}
      {/* ============================================================ */}
      <Section title="Cards">
        <SubSection title="Standard Card">
          <Card>
            <CardHeader>
              <CardTitle>Card Title</CardTitle>
              <CardDescription>Card description with supporting text.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">Card content goes here. This is the main body area.</p>
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">Action</Button>
              <Button variant="outline" size="sm">Cancel</Button>
            </CardFooter>
          </Card>
        </SubSection>

        <SubSection title="Metric Cards">
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard icon={Bot} value={12} label="Active Agents" description="+3 this week" />
            <MetricCard icon={CircleDot} value={48} label="Open Tasks" />
            <MetricCard icon={DollarSign} value="$1,234" label="Monthly Cost" description="Under budget" />
            <MetricCard icon={Zap} value="99.9%" label="Uptime" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TABS                                                         */}
      {/* ============================================================ */}
      <Section title="Tabs">
        <SubSection title="Default (pill) variant">
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="runs">Runs</TabsTrigger>
              <TabsTrigger value="config">Config</TabsTrigger>
              <TabsTrigger value="costs">Costs</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <p className="text-sm text-muted-foreground py-4">Overview tab content.</p>
            </TabsContent>
            <TabsContent value="runs">
              <p className="text-sm text-muted-foreground py-4">Runs tab content.</p>
            </TabsContent>
            <TabsContent value="config">
              <p className="text-sm text-muted-foreground py-4">Config tab content.</p>
            </TabsContent>
            <TabsContent value="costs">
              <p className="text-sm text-muted-foreground py-4">Costs tab content.</p>
            </TabsContent>
          </Tabs>
        </SubSection>

        <SubSection title="Line variant">
          <Tabs defaultValue="summary">
            <TabsList variant="line">
              <TabsTrigger value="summary">Summary</TabsTrigger>
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="comments">Comments</TabsTrigger>
            </TabsList>
            <TabsContent value="summary">
              <p className="text-sm text-muted-foreground py-4">Summary content with underline tabs.</p>
            </TabsContent>
            <TabsContent value="details">
              <p className="text-sm text-muted-foreground py-4">Details content.</p>
            </TabsContent>
            <TabsContent value="comments">
              <p className="text-sm text-muted-foreground py-4">Comments content.</p>
            </TabsContent>
          </Tabs>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  ENTITY ROWS                                                  */}
      {/* ============================================================ */}
      <Section title="Entity Rows">
        <div className="border border-border rounded-md">
          <EntityRow
            leading={
              <>
                <StatusIcon status="in_progress" />
                <PriorityIcon priority="high" />
              </>
            }
            identifier="PAP-001"
            title="Implement authentication flow"
            subtitle="Assigned to Agent Alpha"
            trailing={<StatusBadge status="in_progress" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="done" />
                <PriorityIcon priority="medium" />
              </>
            }
            identifier="PAP-002"
            title="Set up CI/CD pipeline"
            subtitle="Completed 2 days ago"
            trailing={<StatusBadge status="done" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="todo" />
                <PriorityIcon priority="low" />
              </>
            }
            identifier="PAP-003"
            title="Write API documentation"
            trailing={<StatusBadge status="todo" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="blocked" />
                <PriorityIcon priority="critical" />
              </>
            }
            identifier="PAP-004"
            title="Deploy to production"
            subtitle="Blocked by PAP-001"
            trailing={<StatusBadge status="blocked" />}
            selected
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SECRET BINDING PICKER                                        */}
      {/* ============================================================ */}
      <Section title="Secret Binding Picker">
        <div className="grid gap-4 md:grid-cols-2">
          <SubSection title="Empty and selected">
            <div className="space-y-3 rounded-md border border-border p-3">
              <SecretBindingPicker
                companyId="demo-company"
                value={secretBinding}
                onChange={setSecretBinding}
                configPath="env.OPENAI_API_KEY"
                targetType="agent"
                targetId="agent-demo"
                secretsOverride={demoSecrets}
              />
              <SecretBindingPicker
                companyId="demo-company"
                value={{ type: "secret_ref", secretId: demoSecrets[0].id, version: "latest" }}
                onChange={() => {}}
                configPath="env.OPENAI_API_KEY"
                targetType="agent"
                targetId="agent-demo"
                secretsOverride={demoSecrets}
              />
            </div>
          </SubSection>
          <SubSection title="Long name and disabled">
            <div className="space-y-3 rounded-md border border-border p-3">
              <SecretBindingPicker
                companyId="demo-company"
                value={{ type: "secret_ref", secretId: demoSecrets[1].id, version: "latest" }}
                onChange={() => {}}
                configPath="env.DATABASE_URL"
                targetType="routine"
                targetId="nightly-sync"
                secretsOverride={demoSecrets}
              />
              <SecretBindingPicker
                companyId="demo-company"
                value={null}
                onChange={() => {}}
                configPath="env.DISABLED"
                targetType="system"
                targetId="demo"
                disabled
                secretsOverride={demoSecrets}
              />
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SECRETS PATTERNS                                             */}
      {/* ============================================================ */}
      <Section title="Secrets Patterns">
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-md border border-border px-3 py-2">
            <div className="flex items-start gap-2">
              <Cloud className="mt-0.5 size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">Production AWS</div>
                <div className="truncate text-xs text-muted-foreground">us-east-1 / aoa/prod</div>
              </div>
              <StatusBadge status="active" />
            </div>
          </div>
          <div className="rounded-md border border-border px-3 py-2">
            <div className="flex items-start gap-2">
              <KeyRound className="mt-0.5 size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">OpenAI API key</div>
                <div className="truncate font-mono text-xs text-muted-foreground">OPENAI_API_KEY</div>
              </div>
              <Badge variant="outline">v3</Badge>
            </div>
          </div>
          <div className="rounded-md border border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <Activity className="size-4 text-muted-foreground" />
              <StatusBadge status="succeeded" />
              <span className="min-w-0 flex-1 truncate text-sm">agent:agent-demo</span>
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">env.OPENAI_API_KEY / just now</div>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  FILTER BAR                                                   */}
      {/* ============================================================ */}
      <Section title="Filter Bar">
        <FilterBar
          filters={filters}
          onRemove={(key) => setFilters((f) => f.filter((x) => x.key !== key))}
          onClear={() => setFilters([])}
        />
        {filters.length === 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setFilters([
                { key: "status", label: "Status", value: "Active" },
                { key: "priority", label: "Priority", value: "High" },
              ])
            }
          >
            Reset filters
          </Button>
        )}
      </Section>

      {/* ============================================================ */}
      {/*  AVATARS                                                      */}
      {/* ============================================================ */}
      <Section title="Avatars">
        <SubSection title="Sizes">
          <div className="flex items-center gap-3">
            <Avatar size="sm"><AvatarFallback>SM</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>DF</AvatarFallback></Avatar>
            <Avatar size="lg"><AvatarFallback>LG</AvatarFallback></Avatar>
          </div>
        </SubSection>

        <SubSection title="Group">
          <AvatarGroup>
            <Avatar><AvatarFallback>A1</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A2</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A3</AvatarFallback></Avatar>
            <AvatarGroupCount>+5</AvatarGroupCount>
          </AvatarGroup>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  IDENTITY                                                     */}
      {/* ============================================================ */}
      <Section title="Identity">
        <SubSection title="Sizes">
          <div className="flex items-center gap-6">
            <Identity name="Agent Alpha" size="sm" />
            <Identity name="Agent Alpha" />
            <Identity name="Agent Alpha" size="lg" />
          </div>
        </SubSection>

        <SubSection title="Initials derivation">
          <div className="flex flex-col gap-2">
            <Identity name="Director Agent" size="sm" />
            <Identity name="Alpha" size="sm" />
            <Identity name="Quality Assurance Lead" size="sm" />
          </div>
        </SubSection>

        <SubSection title="Custom initials">
          <Identity name="Backend Service" initials="BS" size="sm" />
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLTIPS                                                     */}
      {/* ============================================================ */}
      <Section title="Tooltips">
        <div className="flex items-center gap-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm">Hover me</Button>
            </TooltipTrigger>
            <TooltipContent>This is a tooltip</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm"><Settings /></Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DIALOG                                                       */}
      {/* ============================================================ */}
      <Section title="Dialog">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Open Dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Dialog Title</DialogTitle>
              <DialogDescription>
                This is a sample dialog showing the standard layout with header, content, and footer.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-3">
              <div>
                <Label>Name</Label>
                <Input placeholder="Enter a name" className="mt-1.5" />
              </div>
              <div>
                <Label>Description</Label>
                <Textarea placeholder="Describe..." className="mt-1.5" />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline">Cancel</Button>
              <Button>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>

      {/* ============================================================ */}
      {/*  ALERT DIALOG                                                 */}
      {/* ============================================================ */}
      <Section title="Alert Dialog">
        <p className="text-sm text-muted-foreground max-w-2xl">
          Destructive confirms. Use when an action cannot be undone — delete, archive with side-effects, revoke credentials. Not a general-purpose dialog; prefer <code className="text-xs bg-muted px-1 py-0.5 rounded">Dialog</code> for forms and non-destructive flows.
        </p>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Archive workspace</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Archive this workspace?</AlertDialogTitle>
              <AlertDialogDescription>
                Archiving closes the workspace and releases its runtime resources. Linked tasks remain,
                but their runtime environment will be reset. This cannot be undone automatically.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className={buttonVariants({ variant: "destructive" })}>
                Archive
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Section>

      {/* ============================================================ */}
      {/*  EMPTY STATE                                                  */}
      {/* ============================================================ */}
      <Section title="Empty State">
        <div className="border border-border rounded-md">
          <EmptyState
            icon={Inbox}
            message="No items to show. Create your first one to get started."
            action="Create Item"
            onAction={() => {}}
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROGRESS BARS                                                */}
      {/* ============================================================ */}
      <Section title="Progress Bars (Budget)">
        <div className="space-y-3">
          {[
            { label: "Under budget (40%)", pct: 40, color: "bg-green-400" },
            { label: "Warning (75%)", pct: 75, color: "bg-yellow-400" },
            { label: "Over budget (95%)", pct: 95, color: "bg-red-400" },
          ].map(({ label, pct, color }) => (
            <div key={label} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{label}</span>
                <span className="text-xs font-mono">{pct}%</span>
              </div>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-[width,background-color] duration-150 ${color}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  LOG VIEWER                                                   */}
      {/* ============================================================ */}
      <Section title="Log Viewer">
        <div className="bg-neutral-950 rounded-lg p-3 font-mono text-xs max-h-80 overflow-y-auto">
          <div className="text-foreground">[12:00:01] INFO  Agent started successfully</div>
          <div className="text-foreground">[12:00:02] INFO  Processing task PAP-001</div>
          <div className="text-yellow-400">[12:00:05] WARN  Rate limit approaching (80%)</div>
          <div className="text-foreground">[12:00:08] INFO  Task PAP-001 completed</div>
          <div className="text-red-400">[12:00:12] ERROR Connection timeout to upstream service</div>
          <div className="text-blue-300">[12:00:12] SYS   Retrying connection in 5s...</div>
          <div className="text-foreground">[12:00:17] INFO  Reconnected successfully</div>
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 animate-ping" />
              <span className="inline-flex h-full w-full rounded-full bg-cyan-400" />
            </span>
            <span className="text-cyan-400">Live</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROPERTY ROW PATTERN                                         */}
      {/* ============================================================ */}
      <Section title="Property Row Pattern">
        <div className="border border-border rounded-md p-4 space-y-1 max-w-sm">
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">Status</span>
            <StatusBadge status="active" />
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">Priority</span>
            <PriorityIcon priority="high" />
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">Assignee</span>
            <div className="flex items-center gap-1.5">
              <Avatar size="sm"><AvatarFallback>A</AvatarFallback></Avatar>
              <span className="text-xs">Agent Alpha</span>
            </div>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">Created</span>
            <span className="text-xs">Jan 15, 2025</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  NAVIGATION PATTERNS                                          */}
      {/* ============================================================ */}
      <Section title="Navigation Patterns">
        <SubSection title="Sidebar nav items">
          <div className="w-60 border border-border rounded-md p-3 space-y-0.5 bg-card">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-accent-foreground">
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <CircleDot className="h-4 w-4" />
              Tasks
              <span className="ml-auto text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5">
                12
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Bot className="h-4 w-4" />
              Agents
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Hexagon className="h-4 w-4" />
              Projects
            </div>
          </div>
        </SubSection>

        <SubSection title="View toggle">
          <div className="flex items-center border border-border rounded-md w-fit">
            <button className="px-3 py-1.5 text-xs font-medium bg-accent text-foreground rounded-l-md">
              <ListTodo className="h-3.5 w-3.5 inline mr-1" />
              List
            </button>
            <button className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 rounded-r-md">
              <Target className="h-3.5 w-3.5 inline mr-1" />
              Org
            </button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  GROUPED LIST (Tasks pattern)                                */}
      {/* ============================================================ */}
      <Section title="Grouped List (Tasks pattern)">
        <div>
          <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 rounded-t-md">
            <StatusIcon status="in_progress" />
            <span className="text-sm font-medium">In Progress</span>
            <span className="text-xs text-muted-foreground ml-1">2</span>
          </div>
          <div className="border border-border rounded-b-md">
            <EntityRow
              leading={<PriorityIcon priority="high" />}
              identifier="PAP-101"
              title="Build agent heartbeat system"
              onClick={() => {}}
            />
            <EntityRow
              leading={<PriorityIcon priority="medium" />}
              identifier="PAP-102"
              title="Add cost tracking dashboard"
              onClick={() => {}}
            />
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COMMENT THREAD PATTERN                                       */}
      {/* ============================================================ */}
      <Section title="Comment Thread Pattern">
        <div className="space-y-3 max-w-2xl">
          <h3 className="text-sm font-semibold">Comments (2)</h3>
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">Agent</span>
                <span className="text-xs text-muted-foreground">Jan 15, 2025</span>
              </div>
              <p className="text-sm">Started working on the authentication module. Will need API keys configured.</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">Human</span>
                <span className="text-xs text-muted-foreground">Jan 16, 2025</span>
              </div>
              <p className="text-sm">API keys have been added to the vault. Please proceed.</p>
            </div>
          </div>
          <div className="space-y-2">
            <Textarea placeholder="Leave a comment..." rows={3} />
            <Button size="sm">Comment</Button>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COMPOSER (QUIET OPERATOR)                                    */}
      {/* ============================================================ */}
      <Section title="Composer (Quiet Operator)">
        <p className="text-sm text-muted-foreground max-w-2xl">
          One <code className="font-mono text-xs">ComposerFrame</code> across Commander, Discussions,
          Workspace, and Task Comments: context strip → attachment tray (inside the frame) → editor →
          toolbar with the red Send/Stop. <code className="font-mono text-xs">chrome=&quot;card&quot;</code> renders
          the bordered focus-glow card. Never add overflow to the frame — mention popovers render inside it.
        </p>
        <div className="space-y-4 max-w-2xl">
          <div>
            <p className="text-xs text-muted-foreground mb-2">ComposerFrame chrome=&quot;card&quot; with attachment tray</p>
            <ComposerFrame chrome="card" className="p-3 gap-2">
              <div className="flex flex-wrap gap-2">
                <ComposerAttachmentCard name="dashboard.png" byteSize={980_000} state="ready" onRemove={() => {}} />
                <ComposerAttachmentCard name="brief.pdf" byteSize={421_888} state="ready" onRemove={() => {}} />
              </div>
              <Textarea placeholder="Message discussion… @mention to bring someone in" rows={2} className="border-0 shadow-none focus-visible:ring-0 px-0" />
            </ComposerFrame>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-2">Attachment card states</p>
            <div className="flex flex-wrap gap-2">
              <ComposerAttachmentCard name="deck.pdf" byteSize={1_500_000} state="uploading" onRemove={() => {}} />
              <ComposerAttachmentCard name="deck.pdf" byteSize={1_500_000} state="failed" onRemove={() => {}} onRetry={() => {}} />
              <ComposerAttachmentCard name="plan.md" state="ready" onRemove={() => {}} />
            </div>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  FEEDBACK THUMBS                                              */}
      {/* ============================================================ */}
      <Section title="Feedback Thumbs (F.2)">
        <p className="text-sm text-muted-foreground max-w-2xl">
          Per-user thumbs up/down on agent output. Mounts under agent-authored
          task comments on TaskSlideOver. Reason textarea opens on thumbs-down
          only (matches AoA's normalizeReason — upvote reasons are
          discarded). Click an already-selected thumb to dismiss.
        </p>
        <div className="grid gap-6 md:grid-cols-2 max-w-3xl">
          <SubSection title="No vote (idle)">
            <div className="rounded-md border border-border bg-card p-3">
              <FeedbackThumbs
                issueId="design-guide-issue"
                targetType="issue_comment"
                targetId="00000000-0000-0000-0000-000000000001"
              />
            </div>
          </SubSection>
          <SubSection title="Thumbs-up selected">
            <div className="rounded-md border border-border bg-card p-3">
              <FeedbackThumbs
                issueId="design-guide-issue"
                targetType="issue_comment"
                targetId="00000000-0000-0000-0000-000000000002"
                initialVote={{
                  id: "vote-up",
                  companyId: "company-1",
                  issueId: "design-guide-issue",
                  targetType: "issue_comment",
                  targetId: "00000000-0000-0000-0000-000000000002",
                  authorUserId: "user-1",
                  vote: "up",
                  reason: null,
                  sharedWithLabs: false,
                  sharedAt: null,
                  consentVersion: null,
                  redactionSummary: null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                }}
              />
            </div>
          </SubSection>
          <SubSection title="Thumbs-down with saved reason">
            <div className="rounded-md border border-border bg-card p-3">
              <FeedbackThumbs
                issueId="design-guide-issue"
                targetType="issue_comment"
                targetId="00000000-0000-0000-0000-000000000003"
                initialVote={{
                  id: "vote-down",
                  companyId: "company-1",
                  issueId: "design-guide-issue",
                  targetType: "issue_comment",
                  targetId: "00000000-0000-0000-0000-000000000003",
                  authorUserId: "user-1",
                  vote: "down",
                  reason: "Missed the test case for cancellations",
                  sharedWithLabs: false,
                  sharedAt: null,
                  consentVersion: null,
                  redactionSummary: null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                }}
              />
            </div>
          </SubSection>
          <SubSection title="Inline in a comment card">
            <div className="rounded-md border border-border bg-card p-3 space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-muted-foreground">Claude Agent</span>
                  <span className="text-xs text-muted-foreground">Apr 21</span>
                </div>
                <p className="text-sm">
                  Built the scaffolded handler and wired it through to the
                  routing table. Smoke tests pass.
                </p>
              </div>
              <div className="pt-2 border-t border-border/60">
                <FeedbackThumbs
                  issueId="design-guide-issue"
                  targetType="issue_comment"
                  targetId="00000000-0000-0000-0000-000000000004"
                />
              </div>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  FEEDBACK CONSENT MODAL (F.4)                                 */}
      {/* ============================================================ */}
      <Section title="Feedback Consent Modal (F.4)">
        <p className="text-sm text-muted-foreground max-w-2xl">
          First-vote prompt shown when the sharing preference is{" "}
          <code className="font-mono text-xs">prompt</code>. MVP has two durable
          options (Always / Never) plus Cancel to discard the click. Once
          decided, the preference is persisted and the modal won't reappear for
          that user. Per-vote "just this time" is deferred to Phase I.
        </p>
        <FeedbackConsentModalShowcase />
      </Section>

      {/* ============================================================ */}
      {/*  COST TABLE PATTERN                                           */}
      {/* ============================================================ */}
      <Section title="Cost Table Pattern">
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-accent/20">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Model</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Tokens</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Cost</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className="px-3 py-2">claude-sonnet-4-20250514</td>
                <td className="px-3 py-2 font-mono">1.2M</td>
                <td className="px-3 py-2 font-mono">$18.00</td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-3 py-2">claude-haiku-4-20250506</td>
                <td className="px-3 py-2 font-mono">500k</td>
                <td className="px-3 py-2 font-mono">$1.25</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-medium">Total</td>
                <td className="px-3 py-2 font-mono">1.7M</td>
                <td className="px-3 py-2 font-mono font-medium">$19.25</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SKELETONS                                                    */}
      {/* ============================================================ */}
      <Section title="Skeletons">
        <SubSection title="Individual">
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-8 w-full max-w-sm" />
            <Skeleton className="h-20 w-full" />
          </div>
        </SubSection>

        <SubSection title="Page Skeleton (list)">
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="list" />
          </div>
        </SubSection>

        <SubSection title="Page Skeleton (detail)">
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="detail" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  SEPARATOR                                                    */}
      {/* ============================================================ */}
      <Section title="Separator">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">Horizontal</p>
          <Separator />
          <div className="flex items-center gap-4 h-8">
            <span className="text-sm">Left</span>
            <Separator orientation="vertical" />
            <span className="text-sm">Right</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  ICON REFERENCE                                               */}
      {/* ============================================================ */}
      <Section title="Common Icons (Lucide)">
        <div className="grid grid-cols-4 md:grid-cols-6 gap-4">
          {[
            ["Inbox", Inbox],
            ["ListTodo", ListTodo],
            ["CircleDot", CircleDot],
            ["Hexagon", Hexagon],
            ["Target", Target],
            ["LayoutDashboard", LayoutDashboard],
            ["Bot", Bot],
            ["DollarSign", DollarSign],
            ["History", History],
            ["Search", Search],
            ["Plus", Plus],
            ["Trash2", Trash2],
            ["Settings", Settings],
            ["User", User],
            ["Mail", Mail],
            ["Upload", Upload],
            ["Zap", Zap],
          ].map(([name, Icon]) => {
            const LucideIcon = Icon as React.FC<{ className?: string }>;
            return (
              <div key={name as string} className="flex flex-col items-center gap-1.5 p-2">
                <LucideIcon className="h-4 w-4 text-muted-foreground" />
                <span className="text-[10px] text-muted-foreground font-mono">{name as string}</span>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  USER MENU                                                    */}
      {/* ============================================================ */}
      <Section title="UserMenu">
        <p className="text-sm text-muted-foreground">
          Avatar dropdown shown at the bottom of the sidebar and in the Lobby header.
          Reads the current profile from <code className="font-mono text-xs">/auth/profile</code>.
        </p>
        <SubSection title="Expanded (sidebar open)">
          <div className="max-w-60 rounded-lg border border-border p-2 bg-background">
            <UserMenu />
          </div>
        </SubSection>
        <SubSection title="Collapsed (sidebar collapsed / Lobby header)">
          <div className="w-12 rounded-lg border border-border py-2 bg-background">
            <UserMenu collapsed />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  REPORTS-TO SELECT                                            */}
      {/* ============================================================ */}
      <ReportsToSelectShowcase />

      {/* ============================================================ */}
      {/*  ROUTINE VARIABLES EDITOR                                     */}
      {/* ============================================================ */}
      <RoutineVariablesEditorShowcase />

      {/* ============================================================ */}
      {/*  ROUTINE RUN DIALOG                                           */}
      {/* ============================================================ */}
      <RoutineRunDialogShowcase />

      {/* ============================================================ */}
      {/*  BUDGET PAGE                                                  */}
      {/* ============================================================ */}
      <BudgetPageShowcase />

      {/* ============================================================ */}
      {/*  BUDGET COMPONENTS                                            */}
      {/* ============================================================ */}
      <BudgetComponentsShowcase />

      {/* ============================================================ */}
      {/*  QUOTA COMPONENTS                                             */}
      {/* ============================================================ */}
      <QuotaComponentsShowcase />

      {/* ============================================================ */}
      {/*  FINANCE LEDGER COMPONENTS                                    */}
      {/* ============================================================ */}
      <FinanceLedgerShowcase />

      {/* ============================================================ */}
      {/*  BREAKDOWN COMPONENTS                                         */}
      {/* ============================================================ */}
      <BreakdownComponentsShowcase />

      {/* ============================================================ */}
      {/*  COMPANY EXPORT                                               */}
      {/* ============================================================ */}
      <CompanyExportShowcase />

      {/* ============================================================ */}
      {/*  COMPANY IMPORT                                               */}
      {/* ============================================================ */}
      <CompanyImportShowcase />

      {/* ============================================================ */}
      {/*  KEYBOARD SHORTCUTS                                           */}
      {/* ============================================================ */}
      <Section title="Keyboard Shortcuts">
        <div className="border border-border rounded-md divide-y divide-border text-sm">
          {[
            ["Cmd+K / Ctrl+K", "Open Command Palette"],
            ["C", "New Task (outside inputs)"],
            ["[", "Toggle Sidebar"],
            ["]", "Toggle Properties Panel"],
            ["Cmd+1..9 / Ctrl+1..9", "Switch Company (by rail order)"],
            ["Cmd+Enter / Ctrl+Enter", "Submit markdown comment"],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between px-4 py-2">
              <span className="text-muted-foreground">{desc}</span>
              <kbd className="px-2 py-0.5 text-xs font-mono bg-muted rounded border border-border">
                {key}
              </kbd>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ReportsToSelect showcase                                           */
/* ------------------------------------------------------------------ */

function ReportsToSelectShowcase() {
  const showcaseTree: UnifiedOrgNode[] = [
    {
      id: "agent-cxo",
      name: "Claude Chief of Staff",
      role: "cxo",
      status: "active",
      nodeType: "agent",
      adapterType: "claude_local",
      children: [],
    },
    {
      id: "agent-old",
      name: "Retired Agent",
      role: "engineer",
      status: "terminated",
      nodeType: "agent",
      adapterType: "codex_local",
      children: [],
    },
    {
      id: "user-alice",
      name: "Alice",
      role: "founder",
      status: "active",
      nodeType: "user",
      userRole: "founder",
      children: [],
    },
  ];

  const [normalValue, setNormalValue] = useState("agent:agent-ceo");
  const [terminatedValue, setTerminatedValue] = useState("agent:agent-old");
  const [staleValue, setStaleValue] = useState("user:ghost-id");
  const [customValue, setCustomValue] = useState("");

  return (
    <Section title="Reports-To Select">
      <SubSection title="Normal (active manager selected)">
        <div className="max-w-sm">
          <ReportsToSelect
            orgTree={showcaseTree}
            currentEntityId="user-alice"
            currentEntityType="user"
            value={normalValue}
            onChange={setNormalValue}
          />
        </div>
      </SubSection>

      <SubSection title="Terminated (selected manager is terminated)">
        <div className="max-w-sm">
          <ReportsToSelect
            orgTree={showcaseTree}
            currentEntityId="user-alice"
            currentEntityType="user"
            value={terminatedValue}
            onChange={setTerminatedValue}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Amber chip warns the founder that the saved reporting chain points at
          a terminated agent. User can pick a replacement or clear.
        </p>
      </SubSection>

      <SubSection title="Stale ID (saved value not in current tree)">
        <div className="max-w-sm">
          <ReportsToSelect
            orgTree={showcaseTree}
            currentEntityId="user-alice"
            currentEntityType="user"
            value={staleValue}
            onChange={setStaleValue}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Value references an id that no longer exists in the org (e.g. deleted
          agent). Friendly fallback invites the user to re-pick.
        </p>
      </SubSection>

      <SubSection title="Custom chooseLabel (empty value)">
        <div className="max-w-sm">
          <ReportsToSelect
            orgTree={showcaseTree}
            currentEntityId="user-alice"
            currentEntityType="user"
            value={customValue}
            onChange={setCustomValue}
            chooseLabel="Pick a manager…"
          />
        </div>
      </SubSection>

      <SubSection title="Disabled + empty tree (custom disabledEmptyLabel)">
        <div className="max-w-sm">
          <ReportsToSelect
            orgTree={[]}
            currentEntityId="agent-solo"
            currentEntityType="agent"
            value=""
            onChange={() => {}}
            disabled
            disabledEmptyLabel="No managers yet (Director)"
          />
        </div>
      </SubSection>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/*  RoutineVariablesEditor showcase                                    */
/* ------------------------------------------------------------------ */

function RoutineVariablesEditorShowcase() {
  const routineId = "00000000-0000-0000-0000-000000000000";
  const revisionProps = {
    getBaseRevisionId: () => null,
    onRoutineUpdated: () => undefined,
  };
  return (
    <Section title="Routine Variables Editor">
      <SubSection title="Empty state (no placeholders in title/description)">
        <div className="max-w-2xl">
          <RoutineVariablesEditor
            routineId={routineId}
            title="Daily standup"
            description="Post a summary to the team"
            initialVariables={[]}
            {...revisionProps}
          />
        </div>
      </SubSection>

      <SubSection title="Single detected variable (default metadata)">
        <div className="max-w-2xl">
          <RoutineVariablesEditor
            routineId={routineId}
            title="Review {{topic}}"
            description="Read all notes related to the given topic and summarise."
            initialVariables={[]}
            {...revisionProps}
          />
        </div>
      </SubSection>

      <SubSection title="Multiple variables with configured metadata">
        <div className="max-w-2xl">
          <RoutineVariablesEditor
            routineId={routineId}
            title="Send {{tone}} digest about {{topic}}"
            description="Depth: {{depth}}. Include charts: {{include_charts}}"
            {...revisionProps}
            initialVariables={[
              {
                name: "tone",
                label: "Tone",
                type: "select",
                defaultValue: "neutral",
                required: true,
                options: ["friendly", "neutral", "formal"],
              },
              {
                name: "topic",
                label: "Topic",
                type: "text",
                defaultValue: "weekly wins",
                required: true,
                options: [],
              },
              {
                name: "depth",
                label: "Depth (sentences)",
                type: "number",
                defaultValue: 5,
                required: false,
                options: [],
              },
              {
                name: "include_charts",
                label: "Include charts",
                type: "boolean",
                defaultValue: false,
                required: false,
                options: [],
              },
            ]}
          />
        </div>
      </SubSection>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/*  RoutineRunDialog showcase                                          */
/* ------------------------------------------------------------------ */

function RoutineRunDialogShowcase() {
  const routineId = "00000000-0000-0000-0000-000000000000";
  const [zeroOpen, setZeroOpen] = useState(false);
  const [mixedOpen, setMixedOpen] = useState(false);
  const [requiredOpen, setRequiredOpen] = useState(false);
  return (
    <Section title="Routine Run Dialog">
      <SubSection title="Zero-variable confirmation">
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => setZeroOpen(true)}>
            Open dialog
          </Button>
          <span className="text-xs text-muted-foreground">
            Confirmation only — no form fields.
          </span>
        </div>
        <RoutineRunDialog
          open={zeroOpen}
          onOpenChange={setZeroOpen}
          routineId={routineId}
          routineTitle="Daily standup"
          variables={[]}
        />
      </SubSection>

      <SubSection title="Multi-variable form (mixed types)">
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => setMixedOpen(true)}>
            Open dialog
          </Button>
          <span className="text-xs text-muted-foreground">
            Text + number + boolean + select inputs with prefilled defaults.
          </span>
        </div>
        <RoutineRunDialog
          open={mixedOpen}
          onOpenChange={setMixedOpen}
          routineId={routineId}
          routineTitle="Send {{tone}} digest about {{topic}}"
          variables={[
            {
              name: "tone",
              label: "Tone",
              type: "select",
              defaultValue: "neutral",
              required: true,
              options: ["friendly", "neutral", "formal"],
            },
            {
              name: "topic",
              label: "Topic",
              type: "text",
              defaultValue: "weekly wins",
              required: true,
              options: [],
            },
            {
              name: "depth",
              label: "Depth (sentences)",
              type: "number",
              defaultValue: 5,
              required: false,
              options: [],
            },
            {
              name: "include_charts",
              label: "Include charts",
              type: "boolean",
              defaultValue: false,
              required: false,
              options: [],
            },
          ]}
        />
      </SubSection>

      <SubSection title="Submit disabled (required field empty)">
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => setRequiredOpen(true)}>
            Open dialog
          </Button>
          <span className="text-xs text-muted-foreground">
            Missing list surfaces the required field; Run button is disabled.
          </span>
        </div>
        <RoutineRunDialog
          open={requiredOpen}
          onOpenChange={setRequiredOpen}
          routineId={routineId}
          routineTitle="Review {{topic}}"
          variables={[
            {
              name: "topic",
              label: "Review topic",
              type: "text",
              defaultValue: null,
              required: true,
              options: [],
            },
          ]}
        />
      </SubSection>

      <SettingsTabsShowcase />
    </Section>
  );
}

function FeedbackConsentModalShowcase() {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="default" onClick={() => setOpen(true)}>
          Open consent modal
        </Button>
        <span className="text-xs text-muted-foreground">
          (Decide to dismiss — showcase only; no side effects.)
        </span>
      </div>
      <FeedbackConsentModal
        open={open}
        onOpenChange={setOpen}
        onDecide={() => setOpen(false)}
      />
    </div>
  );
}

function SettingsTabsShowcase() {
  return (
    <>
      <SubSection title="Privacy Tab — default (privacy-first: not_allowed, no bundles yet)">
        <div className="rounded-xl border border-border bg-background p-5">
          <PrivacyTab
            settings={{
              censorUsernameInLogs: false,
              keyboardShortcuts: false,
              feedbackDataSharingPreference: "not_allowed",
              backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
            }}
            isLoading={false}
            error={null}
            isSaving={false}
            onChange={() => {}}
            bundleHistory={[]}
          />
        </div>
      </SubSection>

      <SubSection title="Privacy Tab — feedback sharing enabled, 3 recent bundles">
        <div className="rounded-xl border border-border bg-background p-5">
          <PrivacyTab
            settings={{
              censorUsernameInLogs: false,
              keyboardShortcuts: false,
              feedbackDataSharingPreference: "allowed",
              backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
            }}
            isLoading={false}
            error={null}
            isSaving={false}
            onChange={() => {}}
            bundleHistory={[
              {
                id: "row-1",
                exportId: "fbexp_0123456789abcdef01234567",
                companyId: "company-1",
                issueId: "issue-1",
                projectId: null,
                authorUserId: "user-1",
                vote: "down",
                status: "local_only",
                destination: null,
                createdAt: "2026-04-22T10:23:00Z",
                sizeBytes: 4200,
              },
              {
                id: "row-2",
                exportId: "fbexp_abcdef0123456789abcdef01",
                companyId: "company-1",
                issueId: "issue-2",
                projectId: null,
                authorUserId: "user-1",
                vote: "up",
                status: "local_only",
                destination: null,
                createdAt: "2026-04-21T16:15:00Z",
                sizeBytes: 2800,
              },
              {
                id: "row-3",
                exportId: "fbexp_ffffffffffffffff11111111",
                companyId: "company-1",
                issueId: "issue-3",
                projectId: null,
                authorUserId: "user-1",
                vote: "down",
                status: "local_only",
                destination: null,
                createdAt: "2026-04-19T16:42:00Z",
                sizeBytes: 7100,
              },
            ]}
          />
        </div>
      </SubSection>

      <SubSection title="Backups Tab — default retention (7d / 4w / 1m)">
        <div className="rounded-xl border border-border bg-background p-5">
          <BackupsTab
            settings={{
              censorUsernameInLogs: false,
              keyboardShortcuts: false,
              feedbackDataSharingPreference: "not_allowed",
              backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
            }}
            isLoading={false}
            error={null}
            isSaving={false}
            onChange={() => {}}
          />
        </div>
      </SubSection>

      <SubSection title="Backups Tab — maximum retention (14d / 4w / 6m)">
        <div className="rounded-xl border border-border bg-background p-5">
          <BackupsTab
            settings={{
              censorUsernameInLogs: false,
              keyboardShortcuts: false,
              feedbackDataSharingPreference: "not_allowed",
              backupRetention: { dailyDays: 14, weeklyWeeks: 4, monthlyMonths: 6 },
            }}
            isLoading={false}
            error={null}
            isSaving={false}
            onChange={() => {}}
          />
        </div>
      </SubSection>

      <SubSection title="Heartbeats Tab — empty (no scheduler agents)">
        <div className="rounded-xl border border-border bg-background p-5">
          <HeartbeatsTabView
            agents={[]}
            actionError={null}
            isTogglingId={null}
            isDisablingAll={false}
            onToggle={() => {}}
            onDisableAll={() => {}}
          />
        </div>
      </SubSection>

      <SubSection title="Heartbeats Tab — mixed (some active, some disabled)">
        <div className="rounded-xl border border-border bg-background p-5">
          <HeartbeatsTabView
            agents={[
              {
                id: "a-1",
                companyId: "comp-1",
                companyName: "Acme",
                companyIssuePrefix: "ACM",
                agentName: "Alpha",
                agentUrlKey: "alpha",
                role: "general",
                title: "Senior Engineer",
                status: "active",
                adapterType: "claude_local",
                intervalSec: 60,
                heartbeatEnabled: true,
                schedulerActive: true,
                lastHeartbeatAt: new Date(Date.now() - 2 * 60 * 1000),
              },
              {
                id: "a-2",
                companyId: "comp-1",
                companyName: "Acme",
                companyIssuePrefix: "ACM",
                agentName: "Bravo",
                agentUrlKey: "bravo",
                role: "lead",
                title: "Product Lead",
                status: "active",
                adapterType: "codex_local",
                intervalSec: 300,
                heartbeatEnabled: false,
                schedulerActive: false,
                lastHeartbeatAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
              },
            ]}
            actionError={null}
            isTogglingId={null}
            isDisablingAll={false}
            onToggle={() => {}}
            onDisableAll={() => {}}
          />
        </div>
      </SubSection>

      <SubSection title="Heartbeats Tab — all disabled (Disable All hidden)">
        <div className="rounded-xl border border-border bg-background p-5">
          <HeartbeatsTabView
            agents={[
              {
                id: "a-1",
                companyId: "comp-1",
                companyName: "Acme",
                companyIssuePrefix: "ACM",
                agentName: "Alpha",
                agentUrlKey: "alpha",
                role: "general",
                title: "Senior Engineer",
                status: "active",
                adapterType: "claude_local",
                intervalSec: 60,
                heartbeatEnabled: false,
                schedulerActive: false,
                lastHeartbeatAt: null,
              },
            ]}
            actionError={null}
            isTogglingId={null}
            isDisablingAll={false}
            onToggle={() => {}}
            onDisableAll={() => {}}
          />
        </div>
      </SubSection>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Budget page showcase                                               */
/* ------------------------------------------------------------------ */

function BudgetPagePreview({ variant }: { variant: "empty" | "loaded" }) {
  const presets = ["Month to Date", "Last 7 Days", "Last 30 Days", "Custom"];
  return (
    <div className="space-y-6 rounded-xl border border-border bg-background p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Budget</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Spend, budgets, quotas, and the finance ledger across the company.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {presets.map((label, i) => (
            <Button
              key={label}
              variant={i === 0 ? "secondary" : "ghost"}
              size="sm"
              disabled
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {variant === "empty" ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            No cost events in this range yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Month to Date</p>
              <p className="text-sm text-muted-foreground">32% utilized</p>
            </div>
            <p className="text-2xl font-bold">
              $32.50{" "}
              <span className="text-base font-normal text-muted-foreground">
                / $100.00
              </span>
            </p>
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-green-400"
                style={{ width: "32%" }}
              />
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {[
          ["Breakdown", "Accounting model + Claude and Codex subscription utilization."],
          ["Budgets", "Budget policies and open incidents."],
          ["Quotas", "Provider rate-limit windows."],
          ["Ledger", "Finance events by biller, by kind, and over time."],
        ].map(([title, desc]) => (
          <Card key={title}>
            <CardContent className="p-4 space-y-1.5">
              <h3 className="text-sm font-semibold">{title}</h3>
              <p className="text-xs text-muted-foreground">{desc}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function BudgetPageShowcase() {
  return (
    <Section title="Budget Page">
      <p className="text-sm text-muted-foreground">
        Standalone Budget page at <code className="font-mono text-xs">/:companyPrefix/budget</code>.
        Shell renders a header + date range picker + summary card + four section
        placeholders. Breakdown / Budgets / Quotas / Ledger content lands in
        follow-up tasks (B.6–B.8).
      </p>
      <SubSection title="Empty state">
        <BudgetPagePreview variant="empty" />
      </SubSection>
      <SubSection title="Loaded state">
        <BudgetPagePreview variant="loaded" />
      </SubSection>
    </Section>
  );
}

function makeDemoPolicy(overrides: Partial<BudgetPolicySummary> = {}): BudgetPolicySummary {
  return {
    id: "demo-policy",
    companyId: "demo",
    scopeType: "company",
    scopeId: "demo",
    scopeName: "Acme Inc",
    metric: "cost_usd",
    windowKind: "month_utc",
    amountCents: 10_000,
    warnPercent: 80,
    hardStopEnabled: true,
    isActive: true,
    observedCents: 2_500,
    utilizationPercent: 25,
    status: "ok",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDemoIncident(overrides: Partial<BudgetIncident> = {}): BudgetIncident {
  return {
    id: "demo-incident",
    companyId: "demo",
    policyId: "demo-policy",
    scopeType: "company",
    scopeId: "demo",
    scopeName: "Acme Inc",
    windowStart: new Date(),
    windowEnd: new Date(),
    thresholdType: "hard_stop",
    amountLimitCents: 10_000,
    amountObservedCents: 11_250,
    status: "open",
    approvalId: null,
    resolvedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function BudgetComponentsShowcase() {
  return (
    <Section title="Budget Components">
      <p className="text-sm text-muted-foreground">
        Policy cards and incident cards used on the Budget page. The sidebar
        marker is a compact warning chip shown under the sidebar Budget nav when
        any active policy crosses its warn or hard-stop threshold.
      </p>

      <SubSection title="BudgetPolicyCard">
        <div className="grid gap-4 md:grid-cols-2">
          <BudgetPolicyCard
            policy={makeDemoPolicy()}
            onEdit={() => {}}
          />
          <BudgetPolicyCard
            policy={makeDemoPolicy({
              status: "warning",
              utilizationPercent: 85,
              observedCents: 8_500,
            })}
            onEdit={() => {}}
          />
          <BudgetPolicyCard
            policy={makeDemoPolicy({
              status: "hard_stop",
              utilizationPercent: 112,
              observedCents: 11_200,
            })}
            onEdit={() => {}}
          />
          <BudgetPolicyCard
            policy={makeDemoPolicy({ isActive: false, scopeName: "Legacy agent" })}
          />
        </div>
      </SubSection>

      <SubSection title="BudgetIncidentCard">
        <div className="grid gap-4 md:grid-cols-2">
          <BudgetIncidentCard incident={makeDemoIncident({ thresholdType: "warning", amountObservedCents: 8_500 })} />
          <BudgetIncidentCard incident={makeDemoIncident()} />
        </div>
      </SubSection>

      <SubSection title="BudgetSidebarMarker">
        <p className="text-sm text-muted-foreground">
          Rendered inline in the sidebar beneath the Budget nav item. Hidden when
          all active policies are healthy; amber when any policy is in warning
          state; red when any policy has hit hard stop. Sample appearance:
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-md border border-border p-3 space-y-2">
            <p className="text-xs text-muted-foreground">Warning (expanded sidebar)</p>
            <div
              data-tone="warning"
              className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300 w-fit"
            >
              <span aria-hidden>⚠</span>
              Warn · Budget 85% used
            </div>
          </div>
          <div className="rounded-md border border-border p-3 space-y-2">
            <p className="text-xs text-muted-foreground">Hard stop (expanded sidebar)</p>
            <div
              data-tone="hard"
              className="flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-600 dark:text-red-400 w-fit"
            >
              <span aria-hidden>⚠</span>
              Over · Budget 112% used
            </div>
          </div>
        </div>
      </SubSection>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/*  Quota Components showcase                                          */
/* ------------------------------------------------------------------ */

function makeDemoQuotaWindow(
  overrides: Partial<ProviderQuotaWindow> = {},
): ProviderQuotaWindow {
  return {
    id: "qw-demo-1",
    companyId: "comp-demo",
    provider: "anthropic",
    model: null,
    windowKind: "5h",
    label: "5h",
    limitValue: 100,
    usedValue: 20,
    usedPercent: 20,
    valueLabel: "20 / 100 msgs",
    resetAt: null,
    lastUpdatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function QuotaComponentsShowcase() {
  const freshTs = new Date().toISOString();
  const staleTs = new Date(Date.now() - 42 * 60_000).toISOString();

  return (
    <Section title="Quota Components">
      <p className="text-sm text-muted-foreground">
        QuotaBar shows a single provider window's utilization with a
        threshold-tinted fill. ProviderQuotaCard groups the 5h / 24h / 7d
        windows for one provider and surfaces last-refreshed freshness. Used
        on the Budget page's Quotas section.
      </p>

      <SubSection title="QuotaBar">
        <div className="space-y-3 max-w-md">
          <QuotaBar label="Healthy (5h)" used={20} limit={100} valueLabel="20 / 100 msgs" />
          <QuotaBar label="Near-limit (24h)" used={75} limit={100} valueLabel="75 / 100 msgs" />
          <QuotaBar label="Over-limit (7d)" used={95} limit={100} valueLabel="95 / 100 msgs" />
          <QuotaBar label="Clamped at 100%+" used={150} limit={100} />
        </div>
      </SubSection>

      <SubSection title="ProviderQuotaCard">
        <div className="grid gap-4 md:grid-cols-2">
          <ProviderQuotaCard
            provider="anthropic"
            windows={[
              makeDemoQuotaWindow({ id: "q-5h", windowKind: "5h", label: "5h", usedValue: 20, usedPercent: 20, valueLabel: "20 / 100 msgs" }),
              makeDemoQuotaWindow({ id: "q-24h", windowKind: "24h", label: "24h", usedValue: 180, limitValue: 300, usedPercent: 60, valueLabel: "180 / 300 msgs" }),
              makeDemoQuotaWindow({ id: "q-7d", windowKind: "7d", label: "7d", usedValue: 600, limitValue: 2000, usedPercent: 30, valueLabel: "600 / 2000 msgs" }),
            ]}
            lastUpdatedAt={freshTs}
            onRefresh={() => {}}
          />
          <ProviderQuotaCard
            provider="openai"
            windows={[
              makeDemoQuotaWindow({ id: "q-o-5h", provider: "openai", windowKind: "5h", label: "5h", usedValue: 90, limitValue: 100, usedPercent: 90, valueLabel: "90 / 100 msgs" }),
              makeDemoQuotaWindow({ id: "q-o-24h", provider: "openai", windowKind: "24h", label: "24h", usedValue: 240, limitValue: 300, usedPercent: 80, valueLabel: "240 / 300 msgs" }),
            ]}
            lastUpdatedAt={staleTs}
            onRefresh={() => {}}
          />
          <ProviderQuotaCard
            provider="google"
            windows={[]}
            lastUpdatedAt={null}
            onRefresh={() => {}}
          />
        </div>
      </SubSection>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/*  Finance ledger showcase                                           */
/* ------------------------------------------------------------------ */

function makeDemoBillerRow(overrides: Partial<FinanceBillerRow> = {}): FinanceBillerRow {
  return {
    biller: "anthropic",
    debitCents: 5_000,
    creditCents: 1_000,
    estimatedDebitCents: 0,
    eventCount: 4,
    kindCount: 2,
    netCents: 4_000,
    ...overrides,
  };
}

function makeDemoKindRow(overrides: Partial<FinanceKindRow> = {}): FinanceKindRow {
  return {
    eventKind: "top_up",
    debitCents: 10_000,
    creditCents: 0,
    estimatedDebitCents: 0,
    eventCount: 1,
    billerCount: 1,
    netCents: 10_000,
    ...overrides,
  };
}

function makeDemoFinanceEvent(overrides: Partial<FinanceEvent> = {}): FinanceEvent {
  return {
    id: "fe-demo-1",
    companyId: "comp-demo",
    agentId: null,
    issueId: null,
    projectId: null,
    goalId: null,
    heartbeatRunId: null,
    costEventId: null,
    billingCode: null,
    description: "Monthly subscription top-up",
    eventKind: "top_up",
    direction: "credit",
    biller: "anthropic",
    provider: null,
    executionAdapterType: null,
    pricingTier: null,
    region: null,
    model: null,
    quantity: null,
    unit: null,
    amountCents: 10_000,
    currency: "USD",
    estimated: false,
    externalInvoiceId: "INV-2026-001",
    metadataJson: null,
    occurredAt: new Date("2026-04-15T12:00:00Z").toISOString(),
    createdAt: new Date("2026-04-15T12:00:00Z").toISOString(),
    ...overrides,
  };
}

function FinanceLedgerShowcase() {
  return (
    <Section title="Finance Ledger Components">
      <p className="text-sm text-muted-foreground">
        Three complementary views of the finance_events ledger. Biller cards
        give a per-source roll-up; the Kind card groups across billers by
        event type; the Timeline renders recent events chronologically. Used
        on the Budget page's Ledger section.
      </p>

      <SubSection title="FinanceBillerCard">
        <div className="grid gap-3 md:grid-cols-2">
          <FinanceBillerCard row={makeDemoBillerRow()} />
          <FinanceBillerCard
            row={makeDemoBillerRow({
              biller: "openai",
              debitCents: 12_500,
              creditCents: 0,
              estimatedDebitCents: 2_500,
              netCents: 12_500,
              eventCount: 18,
              kindCount: 3,
            })}
          />
          <FinanceBillerCard
            row={makeDemoBillerRow({
              biller: null,
              debitCents: 250,
              creditCents: 0,
              estimatedDebitCents: 0,
              netCents: 250,
              eventCount: 1,
              kindCount: 1,
            })}
          />
        </div>
      </SubSection>

      <SubSection title="FinanceKindCard">
        <div className="grid gap-3 md:grid-cols-2">
          <FinanceKindCard rows={[]} />
          <FinanceKindCard
            rows={[
              makeDemoKindRow({ eventKind: "top_up", netCents: 10_000, debitCents: 10_000 }),
              makeDemoKindRow({
                eventKind: "fee",
                netCents: 500,
                debitCents: 500,
                eventCount: 2,
                billerCount: 1,
              }),
              makeDemoKindRow({
                eventKind: "refund",
                netCents: -250,
                debitCents: 0,
                creditCents: 250,
                eventCount: 1,
                billerCount: 1,
              }),
            ]}
          />
        </div>
      </SubSection>

      <SubSection title="FinanceTimelineCard">
        <div className="grid gap-3 md:grid-cols-2">
          <FinanceTimelineCard rows={[]} />
          <FinanceTimelineCard
            rows={[
              makeDemoFinanceEvent(),
              makeDemoFinanceEvent({
                id: "fe-demo-2",
                eventKind: "fee",
                direction: "debit",
                amountCents: 500,
                biller: "openai",
                provider: "openai",
                model: "gpt-4o",
                description: "Overage processing fee",
                estimated: true,
                occurredAt: new Date("2026-04-18T09:30:00Z").toISOString(),
              }),
              makeDemoFinanceEvent({
                id: "fe-demo-3",
                eventKind: "refund",
                direction: "credit",
                amountCents: 1_200,
                biller: "anthropic",
                description: "Credit for duplicated charge",
                occurredAt: new Date("2026-04-20T14:00:00Z").toISOString(),
              }),
            ]}
          />
        </div>
      </SubSection>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/*  Breakdown showcase                                                */
/* ------------------------------------------------------------------ */

function makeDemoModelRow(overrides: Partial<CostByModelRow> = {}): CostByModelRow {
  return {
    model: "claude-3-5-sonnet",
    totalCostCents: 1_200,
    totalInputTokens: 50_000,
    totalCachedInputTokens: 10_000,
    totalOutputTokens: 5_000,
    eventCount: 3,
    ...overrides,
  };
}

function BreakdownComponentsShowcase() {
  const claudeRollup: SubscriptionRollup = {
    spendCents: 3_500,
    eventCount: 12,
    inputTokens: 100_000,
    cachedInputTokens: 25_000,
    outputTokens: 15_000,
  };
  const codexRollup: SubscriptionRollup = {
    spendCents: 1_800,
    eventCount: 6,
    inputTokens: 40_000,
    cachedInputTokens: 0,
    outputTokens: 8_000,
  };

  return (
    <Section title="Breakdown Components">
      <p className="text-sm text-muted-foreground">
        Per-model cost breakdown + subscription utilization panels. These
        populate the Budget page's Breakdown section alongside the ledger
        views.
      </p>

      <SubSection title="AccountingModelCard">
        <div className="grid gap-3 md:grid-cols-2">
          <AccountingModelCard rows={[]} />
          <AccountingModelCard
            rows={[
              makeDemoModelRow({ model: "gpt-4o", totalCostCents: 500, totalInputTokens: 20_000, totalOutputTokens: 2_000, totalCachedInputTokens: 0, eventCount: 2 }),
              makeDemoModelRow({ model: "claude-3-5-sonnet", totalCostCents: 2_500, totalInputTokens: 80_000, totalOutputTokens: 10_000, totalCachedInputTokens: 15_000, eventCount: 7 }),
              makeDemoModelRow({ model: "gemini-1.5-pro", totalCostCents: 100, totalInputTokens: 5_000, totalOutputTokens: 800, totalCachedInputTokens: 0, eventCount: 1 }),
              makeDemoModelRow({ model: null, totalCostCents: 50, totalInputTokens: 1_000, totalOutputTokens: 200, totalCachedInputTokens: 0, eventCount: 1 }),
            ]}
          />
        </div>
      </SubSection>

      <SubSection title="ClaudeSubscriptionPanel">
        <div className="grid gap-3 md:grid-cols-2">
          <ClaudeSubscriptionPanel rollup={null} />
          <ClaudeSubscriptionPanel rollup={claudeRollup} />
        </div>
      </SubSection>

      <SubSection title="CodexSubscriptionPanel">
        <div className="grid gap-3 md:grid-cols-2">
          <CodexSubscriptionPanel rollup={null} />
          <CodexSubscriptionPanel rollup={codexRollup} />
        </div>
      </SubSection>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/*  CompanyExport showcase                                             */
/* ------------------------------------------------------------------ */

function CompanyExportShowcase() {
  const cleanPreview = {
    counts: {
      agents: 5,
      projects: 2,
      issues: 18,
      skills: 3,
      routines: 1,
      envInputs: 4,
      internalAgentConfig: 1 as const,
    },
    files: ["README.md", "agents/ceo.md", "agents/eng-lead.md", "skills/readme-gen/SKILL.md"],
    estimatedBytes: 12_800,
    warnings: [],
  };
  const financePreview = {
    counts: {
      agents: 5,
      projects: 2,
      issues: 18,
      skills: 3,
      routines: 1,
      envInputs: 4,
      internalAgentConfig: 1 as const,
      budgetPolicies: 6,
      costEvents: 1284,
      financeEvents: 12,
      quotaWindows: 4,
      workflowTemplates: 3,
    },
    files: ["README.md", "agents/ceo.md"],
    estimatedBytes: 512_000,
    warnings: [
      "Large bundle: 1284 cost events included.",
      "Quota windows are point-in-time snapshots; consider refresh post-import.",
    ],
  };
  const warningPreview = {
    counts: { agents: 5, projects: 2, issues: 18, skills: 3, routines: 1, envInputs: 4 },
    files: ["README.md", "agents/ceo.md"],
    estimatedBytes: 8_192,
    warnings: [
      "Agent eng-lead env PATH was omitted because it is system-dependent.",
      "Skill custom-tool missing source metadata; exported markdown only.",
    ],
  };

  return (
    <Section title="Company Export">
      <p className="text-sm text-muted-foreground">
        Standalone export page at <code>/export</code>. Entity inclusion toggles,
        preview summary, and download action. Warnings render with amber tone.
      </p>

      <SubSection title="Initial state (no preview)">
        <div className="rounded-md border border-border p-4">
          <CompanyExportPage showcase />
        </div>
      </SubSection>

      <SubSection title="Preview shown (no warnings)">
        <div className="rounded-md border border-border p-4">
          <CompanyExportPage showcase initialPreview={cleanPreview} />
        </div>
      </SubSection>

      <SubSection title="Preview with Budget & Finance entities (E.2)">
        <div className="rounded-md border border-border p-4">
          <CompanyExportPage showcase initialPreview={financePreview} />
        </div>
      </SubSection>

      <SubSection title="Preview with warnings">
        <div className="rounded-md border border-border p-4">
          <CompanyExportPage showcase initialPreview={warningPreview} />
        </div>
      </SubSection>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/*  CompanyImport showcase                                             */
/* ------------------------------------------------------------------ */

function CompanyImportShowcase() {
  const sampleBundle = {
    manifest: {
      schemaVersion: 2,
      generatedAt: "2026-04-21T00:00:00Z",
      source: { companyId: "comp-sample", companyName: "Acme Portable" },
      includes: {
        company: true,
        agents: true,
        projects: true,
        issues: true,
        skills: false,
        routines: false,
        envInputs: false,
      },
      company: {
        path: "company.md",
        name: "Acme Portable",
        description: "Sample bundle for the design guide",
        brandColor: null,
        requireBoardApprovalForNewAgents: false,
      },
      agents: [],
      requiredSecrets: [],
    },
    files: { "company.md": "# Acme Portable" },
  };

  const cleanPreview = {
    include: {
      company: true,
      agents: true,
      projects: true,
      issues: true,
      skills: false,
      routines: false,
      envInputs: false,
    },
    targetCompanyId: null,
    targetCompanyName: "Acme Portable",
    collisionStrategy: "rename" as const,
    selectedAgentSlugs: ["cxo", "lead"],
    plan: {
      companyAction: "create" as const,
      agentPlans: [
        { slug: "cxo", action: "create" as const, plannedName: "Chief of Staff", existingAgentId: null, reason: null },
        { slug: "lead", action: "create" as const, plannedName: "Eng Lead", existingAgentId: null, reason: null },
      ],
      projectPlans: [
        { slug: "eng", action: "create" as const, plannedName: "Engineering", existingProjectId: null, reason: null },
      ],
      issuePlans: [
        { slug: "launch", action: "create" as const, plannedTitle: "Ship MVP", reason: null },
      ],
      skillPlans: [],
      routinePlans: [],
    },
    requiredSecrets: [],
    warnings: [],
    errors: [],
  };

  const warningPreview = {
    ...cleanPreview,
    plan: {
      ...cleanPreview.plan,
      agentPlans: [
        { slug: "cxo", action: "create" as const, plannedName: "Chief of Staff", existingAgentId: null, reason: null },
        { slug: "lead", action: "skip" as const, plannedName: "Eng Lead", existingAgentId: "a-1", reason: "Slug already exists" },
      ],
    },
    warnings: [
      { kind: "unknown_section" as const, section: "memory", message: "Unknown section: memory (12 items skipped)" },
      { kind: "deprecated_field" as const, message: "PATH env var was omitted on agent cxo" },
    ],
    requiredSecrets: [
      {
        key: "GITHUB_TOKEN",
        description: "Required for git operations",
        agentSlug: "cxo",
        providerHint: null,
      },
    ],
  };

  const financeBundle = {
    manifest: {
      ...sampleBundle.manifest,
      internalAgentConfig: {
        executionMode: "api",
        provider: "anthropic",
        model: "claude-opus-4-7",
        autonomyLevel: 2,
        notificationPreference: "mentions",
        contextTokenBudget: 8000,
        proactiveIntervalMinutes: 240,
      },
      budgetPolicies: new Array(6).fill(null).map((_, i) => ({ slug: `policy-${i}` })),
      costEvents: new Array(1284).fill(null).map((_, i) => ({ slug: `ce-${i}` })),
      financeEvents: new Array(12).fill(null).map((_, i) => ({ slug: `fe-${i}` })),
      quotaWindows: new Array(4).fill(null).map((_, i) => ({ slug: `qw-${i}` })),
      workflowTemplates: new Array(3).fill(null).map((_, i) => ({ slug: `wt-${i}` })),
    } as unknown as typeof sampleBundle.manifest,
    files: sampleBundle.files,
  };

  return (
    <Section title="Company Import">
      <p className="text-sm text-muted-foreground">
        Standalone import page at <code>/import</code>. File upload, collision strategy,
        preview with plan summary, warnings, and required secrets.
      </p>

      <SubSection title="Initial state (no file)">
        <div className="rounded-md border border-border p-4">
          <CompanyImportPage showcase="initial" />
        </div>
      </SubSection>

      <SubSection title="Bundle parsed (ready to preview)">
        <div className="rounded-md border border-border p-4">
          <CompanyImportPage showcase="parsed" initialBundle={sampleBundle} />
        </div>
      </SubSection>

      <SubSection title="Preview shown (clean)">
        <div className="rounded-md border border-border p-4">
          <CompanyImportPage
            showcase="preview"
            initialBundle={sampleBundle}
            initialPreview={cleanPreview}
          />
        </div>
      </SubSection>

      <SubSection title="Preview with warnings + secrets">
        <div className="rounded-md border border-border p-4">
          <CompanyImportPage
            showcase="preview-warnings"
            initialBundle={sampleBundle}
            initialPreview={warningPreview}
          />
        </div>
      </SubSection>

      <SubSection title="Preview with Budget & Finance entity counts (E.2)">
        <div className="rounded-md border border-border p-4">
          <CompanyImportPage
            showcase="preview"
            initialBundle={financeBundle}
            initialPreview={cleanPreview}
          />
        </div>
      </SubSection>
    </Section>
  );
}
