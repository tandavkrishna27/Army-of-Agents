import { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Unified org-tree node containing both agents and humans.
 * Defined locally until T4 lands the shared type.
 */
export interface UnifiedOrgNode {
  id: string;
  name: string;
  role: string;
  status: string;
  nodeType: "agent" | "user";

  adapterType?: string;
  trustScore?: number;
  icon?: string;

  email?: string;
  userRole?: "founder" | "team_lead" | "team_member";
  departmentName?: string;
  avatarUrl?: string;

  children: UnifiedOrgNode[];
}

/** Sentinel used internally because Radix Select forbids empty-string values. */
const NONE_VALUE = "__none__";

export interface ReportsToSelectProps {
  /** The full org tree (forest of UnifiedOrgNode roots). */
  orgTree: UnifiedOrgNode[];
  /** ID of the entity being edited (to exclude from options). */
  currentEntityId: string;
  /** Type of the entity being edited. */
  currentEntityType: "agent" | "user";
  /** Current value as "nodeType:id" string, or empty string for none/root. */
  value: string;
  /** Callback with the composite value ("agent:id", "user:id", or "" for root). */
  onChange: (value: string) => void;
  /** Restrict options to a single nodeType (e.g. 'user' for humans tab per D1). */
  filterToType?: "agent" | "user";
  disabled?: boolean;
  className?: string;
  /** Trigger placeholder when no value is selected. Default: "None (root)". */
  chooseLabel?: string;
  /** Trigger label when disabled and no options are available. Default: falls back to chooseLabel. */
  disabledEmptyLabel?: string;
}

/** Recursively flatten a UnifiedOrgNode tree into a flat list. */
export function flattenOrgTree(nodes: UnifiedOrgNode[]): UnifiedOrgNode[] {
  const result: UnifiedOrgNode[] = [];
  function walk(list: UnifiedOrgNode[]) {
    for (const node of list) {
      result.push(node);
      if (node.children.length > 0) {
        walk(node.children);
      }
    }
  }
  walk(nodes);
  return result;
}

function detailText(node: UnifiedOrgNode): string {
  if (node.nodeType === "agent") {
    return node.adapterType ?? node.role;
  }
  if (node.userRole) {
    const labels: Record<string, string> = {
      founder: "Founder",
      team_lead: "Team Lead",
      team_member: "Team Member",
    };
    return labels[node.userRole] ?? node.userRole;
  }
  return node.role;
}

function parseValue(value: string): { nodeType: "agent" | "user"; id: string } | null {
  if (!value) return null;
  const [type, ...rest] = value.split(":");
  const id = rest.join(":");
  if ((type !== "agent" && type !== "user") || !id) return null;
  return { nodeType: type, id };
}

export function ReportsToSelect({
  orgTree,
  currentEntityId,
  currentEntityType,
  value,
  onChange,
  filterToType,
  disabled,
  className,
  chooseLabel = "None (root)",
  disabledEmptyLabel,
}: ReportsToSelectProps) {
  const { agents, teamMembers, currentNode } = useMemo(() => {
    const flat = flattenOrgTree(orgTree);

    // Exclude self
    const filtered = flat.filter(
      (node) =>
        !(node.id === currentEntityId && node.nodeType === currentEntityType),
    );

    // Apply filterToType restriction
    const applicable = filterToType
      ? filtered.filter((node) => node.nodeType === filterToType)
      : filtered;

    // Resolve currentValue against the full tree (including self) so warnings
    // are accurate even for edge cases.
    const parsed = parseValue(value);
    const current = parsed
      ? flat.find((n) => n.nodeType === parsed.nodeType && n.id === parsed.id) ?? null
      : null;

    return {
      agents: applicable.filter((n) => n.nodeType === "agent"),
      teamMembers: applicable.filter((n) => n.nodeType === "user"),
      currentNode: current,
    };
  }, [orgTree, currentEntityId, currentEntityType, filterToType, value]);

  const hasAgents = agents.length > 0;
  const hasTeamMembers = teamMembers.length > 0;
  const hasOptions = hasAgents || hasTeamMembers;

  const isTerminated = currentNode?.status === "terminated";
  const isStale = Boolean(value && !currentNode);

  const selectValue = value || NONE_VALUE;

  function handleChange(next: string) {
    onChange(next === NONE_VALUE ? "" : next);
  }

  const triggerContent = (() => {
    if (disabled && !hasOptions && !currentNode) {
      return (
        <span className="text-muted-foreground">
          {disabledEmptyLabel ?? chooseLabel}
        </span>
      );
    }
    if (isStale) {
      return (
        <span className="text-muted-foreground">Unknown manager (stale ID)</span>
      );
    }
    if (isTerminated && currentNode) {
      return (
        <span className="text-amber-700 dark:text-amber-300">
          {`${currentNode.name} (terminated)`}
        </span>
      );
    }
    if (!value) {
      return <span className="text-muted-foreground">{chooseLabel}</span>;
    }
    return <SelectValue />;
  })();

  return (
    <Select value={selectValue} onValueChange={handleChange} disabled={disabled}>
      <SelectTrigger
        className={cn(
          isTerminated && "border-amber-500/50 bg-amber-500/10",
          className,
        )}
      >
        {triggerContent}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_VALUE}>None (root)</SelectItem>

        {hasAgents && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Agents</SelectLabel>
              {agents.map((node) => (
                <SelectItem key={`agent:${node.id}`} value={`agent:${node.id}`}>
                  <span className="flex flex-col">
                    <span>{node.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {detailText(node)}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}

        {hasTeamMembers && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Team Members</SelectLabel>
              {teamMembers.map((node) => (
                <SelectItem key={`user:${node.id}`} value={`user:${node.id}`}>
                  <span className="flex flex-col">
                    <span>{node.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {detailText(node)}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  );
}
