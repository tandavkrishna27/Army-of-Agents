import { Component, createRef, type ErrorInfo, type ReactNode } from "react";

// Vite injects `import.meta.env.DEV`; the UI tsconfig doesn't reference
// `vite/client`, so read it through a narrow cast instead of the ambient type.
const isDev = Boolean(
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV,
);

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  supportId: string | null;
  copied: boolean;
}

function makeSupportId(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * App-root error boundary. Catches render crashes anywhere in the tree so a
 * thrown error in Home/Tasks/Discussions/Commander shows a recoverable
 * fallback instead of a blank white screen.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null, supportId: null, copied: false };
  private readonly fallbackRef = createRef<HTMLDivElement>();

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, supportId: makeSupportId(), copied: false };
  }

  componentDidMount(): void {
    // Release the inline onboarding bootstrap only after React has committed a
    // real surface. A requestAnimationFrame scheduled beside render can run
    // before a suspended/slow initial commit and expose the browser's white
    // default background.
    document.documentElement.removeAttribute("data-aoa-onboarding-boot");
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("Uncaught render error:", error, info.componentStack);
    this.fallbackRef.current?.focus();
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleCopySupportId = async (): Promise<void> => {
    const { supportId } = this.state;
    if (!supportId || !navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(supportId);
    this.setState({ copied: true });
  };

  render(): ReactNode {
    const { error, supportId, copied } = this.state;
    if (!error) return this.props.children;
    const onboarding = window.location.pathname.startsWith("/onboarding");

    return (
      <div
        className="flex min-h-screen items-center justify-center bg-bg p-6"
        style={onboarding ? { background: "#0a0a0a", color: "#eeeeee", colorScheme: "dark" } : undefined}
      >
        <div
          ref={this.fallbackRef}
          role="alert"
          tabIndex={-1}
          className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-sm outline-none"
        >
          <h1 className="text-lg font-semibold text-foreground">
            Something went wrong
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The page hit an unexpected error. Reloading usually fixes it.
          </p>
          {supportId && (
            <div className="mt-4 rounded-md border border-border bg-field p-3 text-left text-xs text-muted-foreground">
              <div className="font-medium text-foreground">Support ID</div>
              <code className="mt-1 block break-all">{supportId}</code>
              <button
                type="button"
                onClick={() => void this.handleCopySupportId()}
                className="mt-2 min-h-11 rounded-md border border-border px-3 py-2 font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                {copied ? "Copied" : "Copy support ID"}
              </button>
            </div>
          )}
          {isDev && (
            <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-field p-3 text-left text-xs text-muted-foreground">
              {error.message}
            </pre>
          )}
          <button
            type="button"
            onClick={this.handleReload}
            className="mt-5 inline-flex h-8 items-center justify-center rounded-md bg-brand px-3 text-sm font-semibold text-white transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-focus-ring"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
