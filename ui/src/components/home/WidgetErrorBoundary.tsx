import { Component, type ReactNode } from "react";

export class WidgetErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed)
      return <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">This widget couldn't load.</div>;
    return this.props.children;
  }
}
