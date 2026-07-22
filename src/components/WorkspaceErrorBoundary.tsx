import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface WorkspaceErrorBoundaryProps {
  children: ReactNode;
  resetKeys?: unknown[];
}

interface WorkspaceErrorBoundaryState {
  error: Error | null;
}

function resetKeysChanged(previous: unknown[] = [], next: unknown[] = []): boolean {
  return previous.length !== next.length || previous.some((value, index) => !Object.is(value, next[index]));
}

export class WorkspaceErrorBoundary extends Component<
  WorkspaceErrorBoundaryProps,
  WorkspaceErrorBoundaryState
> {
  state: WorkspaceErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): WorkspaceErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(previousProps: WorkspaceErrorBoundaryProps): void {
    if (
      this.state.error &&
      resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)
    ) {
      this.setState({ error: null });
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="border-border bg-card/70 w-full max-w-md rounded-2xl border p-8 text-center shadow-sm">
          <div className="bg-destructive/10 mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl">
            <AlertTriangle className="text-destructive h-6 w-6" />
          </div>
          <h2 className="text-lg font-semibold">Task workspace crashed</h2>
          <p className="text-muted-foreground mt-2 text-sm leading-6">
            The main task view hit an unexpected error. Try again, or reload the app if it keeps happening.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button className="h-9 text-[13px]" onClick={this.handleRetry}>
              Try Again
            </Button>
            <Button variant="outline" className="h-9 text-[13px]" onClick={this.handleReload}>
              Reload App
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
