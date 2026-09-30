import { Bot, Building2, ChevronDown, CircleDot, FolderKanban, MessageSquare, Target } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useDialog } from "@/context/DialogContext";

/**
 * Home's Create menu (Plan 7 Task 1): a single, prominent, solid trigger that
 * opens the full set of six creators — Task / Discussion / Goal (top group),
 * then Agent / Department / Project (bottom group, below a separator).
 *
 * Plan 6 Task 1 originally shipped this as a subtle outline "+ New" button
 * with just the three top-group creators. Founder feedback (Plan 7) asked for
 * Home's create affordance to be as prominent as the Lobby's solid
 * "+ New organization" button, and to also reach Agent/Department/Project
 * creation without leaving Home. Unlike the Lobby, Home has no single default
 * create action, so this stays one menu (not a split button).
 */
export function NewMenu() {
  const { openNewIssue, openDiscussionCapture, openNewGoal, openNewAgent, openNewProject } = useDialog();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" aria-label="Create">
          Create
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => openNewIssue()}>
          <CircleDot className="size-4" aria-hidden="true" />
          Task
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDiscussionCapture()}>
          <MessageSquare className="size-4" aria-hidden="true" />
          Discussion
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openNewGoal()}>
          <Target className="size-4" aria-hidden="true" />
          Goal
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openNewAgent()}>
          <Bot className="size-4" aria-hidden="true" />
          Agent
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openNewProject({ type: "department" })}>
          <Building2 className="size-4" aria-hidden="true" />
          Department
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openNewProject({ type: "project" })}>
          <FolderKanban className="size-4" aria-hidden="true" />
          Project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
