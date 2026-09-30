import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Copy, RotateCcw, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface WorkspaceErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
}

interface WorkspaceErrorBoundaryState {
  error: Error | null;
  copied: boolean;
}

export class WorkspaceErrorBoundary extends Component<WorkspaceErrorBoundaryProps, WorkspaceErrorBoundaryState> {
  state: WorkspaceErrorBoundaryState = {
    error: null,
    copied: false,
  };

  static getDerivedStateFromError(error: Error): WorkspaceErrorBoundaryState {
    return { error, copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Workspace render error", error, info.componentStack);
  }

  componentDidUpdate(prevProps: WorkspaceErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, copied: false });
    }
  }

  private retry = () => {
    this.setState({ error: null, copied: false });
  };

  private reload = () => {
    window.location.reload();
  };

  private copyDiagnostics = async () => {
    const { error } = this.state;
    const diagnostics = [
      "Workspace render error",
      `URL: ${window.location.href}`,
      `Message: ${error?.message ?? "Unknown error"}`,
      error?.stack ? `Stack:\n${error.stack}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    await navigator.clipboard?.writeText(diagnostics);
    this.setState({ copied: true });
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        className="flex h-full min-h-0 items-center justify-center bg-background p-6"
        data-testid="workspace-render-error"
      >
        <div className="w-full max-w-md rounded-lg border border-border/70 bg-card/80 p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-foreground">Workspace view hit a rendering issue</h2>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                The workspace is still available. Retry the view, reload the workspace, or copy diagnostics for debugging.
              </p>
              <p className="mt-3 truncate rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 font-mono text-xs text-muted-foreground">
                {this.state.error.message}
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={this.retry}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={this.reload}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Reload workspace
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={this.copyDiagnostics}>
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              {this.state.copied ? "Copied" : "Copy diagnostics"}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
