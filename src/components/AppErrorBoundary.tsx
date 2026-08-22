import { Component, type ErrorInfo, type ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Uncaught application error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <main className="bg-background text-foreground flex h-screen items-center justify-center p-6">
        <section
          role="alert"
          className="border-border bg-card w-full max-w-lg rounded-xl border p-6 shadow-sm"
        >
          <h1 className="text-lg font-semibold">JiraSync Hub ran into a problem</h1>
          <p className="text-muted-foreground mt-2 text-sm leading-6">
            Your local data is still stored on this device. Restart the app to continue.
          </p>
          <pre className="bg-muted mt-4 max-h-32 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="bg-primary text-primary-foreground hover:bg-primary/90 mt-4 rounded-md px-4 py-2 text-sm font-medium"
            onClick={() => window.location.reload()}
          >
            Restart app
          </button>
        </section>
      </main>
    );
  }
}
