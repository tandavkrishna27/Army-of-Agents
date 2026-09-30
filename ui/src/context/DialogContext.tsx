import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { Issue } from "@armyofagents/shared";

interface NewIssueDefaults {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  projectId?: string;
  assigneeAgentId?: string;
  onCreated?: (issue: Issue) => void;
}

interface NewGoalDefaults {
  parentId?: string;
  projectIds?: string[];
}

interface NewProjectDefaults {
  type?: "department" | "project";
}

export interface DiscussionCaptureDefaults {
  scopeType?: string;
  scopeId?: string;
  existingDiscussionId?: string;
}

export interface NewThreadDefaults {
  title?: string;
  scopeType?: string;
  scopeId?: string;
  initialType?: "idea" | "discussion" | "goal" | "transcript" | "document";
}

interface DialogContextValue {
  newIssueOpen: boolean;
  newIssueDefaults: NewIssueDefaults;
  openNewIssue: (defaults?: NewIssueDefaults) => void;
  closeNewIssue: () => void;
  newProjectOpen: boolean;
  newProjectDefaults: NewProjectDefaults;
  openNewProject: (defaults?: NewProjectDefaults) => void;
  closeNewProject: () => void;
  newGoalOpen: boolean;
  newGoalDefaults: NewGoalDefaults;
  openNewGoal: (defaults?: NewGoalDefaults) => void;
  closeNewGoal: () => void;
  newAgentOpen: boolean;
  openNewAgent: () => void;
  closeNewAgent: () => void;
  discussionCaptureOpen: boolean;
  discussionCaptureDefaults: DiscussionCaptureDefaults;
  openDiscussionCapture: (defaults?: DiscussionCaptureDefaults) => void;
  closeDiscussionCapture: () => void;
  newThreadOpen: boolean;
  newThreadDefaults: NewThreadDefaults;
  openNewThread: (defaults?: NewThreadDefaults) => void;
  closeNewThread: () => void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [newIssueDefaults, setNewIssueDefaults] = useState<NewIssueDefaults>({});
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectDefaults, setNewProjectDefaults] = useState<NewProjectDefaults>({});
  const [newGoalOpen, setNewGoalOpen] = useState(false);
  const [newGoalDefaults, setNewGoalDefaults] = useState<NewGoalDefaults>({});
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [discussionCaptureOpen, setDiscussionCaptureOpen] = useState(false);
  const [discussionCaptureDefaults, setDiscussionCaptureDefaults] = useState<DiscussionCaptureDefaults>({});
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [newThreadDefaults, setNewThreadDefaults] = useState<NewThreadDefaults>({});

  const openNewIssue = useCallback((defaults: NewIssueDefaults = {}) => {
    setNewIssueDefaults(defaults);
    setNewIssueOpen(true);
  }, []);

  const closeNewIssue = useCallback(() => {
    setNewIssueOpen(false);
    setNewIssueDefaults({});
  }, []);

  const openNewProject = useCallback((defaults: NewProjectDefaults = {}) => {
    setNewProjectDefaults(defaults);
    setNewProjectOpen(true);
  }, []);

  const closeNewProject = useCallback(() => {
    setNewProjectOpen(false);
    setNewProjectDefaults({});
  }, []);

  const openNewGoal = useCallback((defaults: NewGoalDefaults = {}) => {
    setNewGoalDefaults(defaults);
    setNewGoalOpen(true);
  }, []);

  const closeNewGoal = useCallback(() => {
    setNewGoalOpen(false);
    setNewGoalDefaults({});
  }, []);

  const openNewAgent = useCallback(() => {
    setNewAgentOpen(true);
  }, []);

  const closeNewAgent = useCallback(() => {
    setNewAgentOpen(false);
  }, []);

  const openDiscussionCapture = useCallback((defaults: DiscussionCaptureDefaults = {}) => {
    setDiscussionCaptureDefaults(defaults);
    setDiscussionCaptureOpen(true);
  }, []);

  const closeDiscussionCapture = useCallback(() => {
    setDiscussionCaptureOpen(false);
    setDiscussionCaptureDefaults({});
  }, []);

  const openNewThread = useCallback((defaults: NewThreadDefaults = {}) => {
    setNewThreadDefaults(defaults);
    setNewThreadOpen(true);
  }, []);

  const closeNewThread = useCallback(() => {
    setNewThreadOpen(false);
    setNewThreadDefaults({});
  }, []);

  return (
    <DialogContext.Provider
      value={{
        newIssueOpen,
        newIssueDefaults,
        openNewIssue,
        closeNewIssue,
        newProjectOpen,
        newProjectDefaults,
        openNewProject,
        closeNewProject,
        newGoalOpen,
        newGoalDefaults,
        openNewGoal,
        closeNewGoal,
        newAgentOpen,
        openNewAgent,
        closeNewAgent,
        discussionCaptureOpen,
        discussionCaptureDefaults,
        openDiscussionCapture,
        closeDiscussionCapture,
        newThreadOpen,
        newThreadDefaults,
        openNewThread,
        closeNewThread,
      }}
    >
      {children}
    </DialogContext.Provider>
  );
}

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error("useDialog must be used within DialogProvider");
  }
  return ctx;
}
