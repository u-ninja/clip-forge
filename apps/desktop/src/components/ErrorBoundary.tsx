import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "./ErrorNotice";

/** Keeps a crashing screen from blanking the whole window; offers a retry. */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string },
  { error: unknown }
> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("UI error", error, info.componentStack);
  }

  override componentDidUpdate(prev: { resetKey?: string }): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="space-y-3 p-8">
        <ErrorNotice error={this.state.error} title="This screen failed to load" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            this.setState({ error: null });
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
}
