import { type MouseEvent, useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTaskStore } from "@/store/task-store";
import { getJiraAccounts } from "@/lib/jira-db";
import {
  onSyncResult,
  onSyncStatus,
  startBackgroundSync,
  stopBackgroundSync,
} from "@/lib/sync-service";
import { toast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/utils";
import { onRunEvent } from "@/lib/harness";
import { HashRouter, Route, Routes } from "react-router-dom";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { TitleBar } from "@/components/TitleBar";
import { AppUpdater } from "@/components/AppUpdater";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  startWindowResize,
  usesNativeMacTitlebar,
  type WindowResizeDirection,
} from "@/lib/desktop";
import Index from "./pages/Index.tsx";
import AiBoard from "./pages/AiBoard.tsx";
import NotFound from "./pages/NotFound.tsx";

function ResizeHandles() {
  const onMouseDown = useCallback(
    (direction: WindowResizeDirection) => (event: MouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      void startWindowResize(direction);
    },
    [],
  );

  if (usesNativeMacTitlebar()) return null;

  const edge = "fixed z-[9999] select-none";
  return (
    <>
      <div
        className={edge}
        style={{ top: 0, right: 0, width: 6, bottom: 6, cursor: "e-resize" }}
        onMouseDown={onMouseDown("East")}
      />
      <div
        className={edge}
        style={{ bottom: 0, left: 0, right: 6, height: 6, cursor: "s-resize" }}
        onMouseDown={onMouseDown("South")}
      />
      <div
        className={edge}
        style={{ bottom: 0, right: 0, width: 12, height: 12, cursor: "se-resize" }}
        onMouseDown={onMouseDown("SouthEast")}
      />
    </>
  );
}

const App = () => {
  const showCustomTitlebar = !usesNativeMacTitlebar();
  const { isLoaded, load, applySyncResult, setSyncing } = useTaskStore(
    useShallow((state) => ({
      isLoaded: state.isLoaded,
      load: state.loadFromDB,
      applySyncResult: state.applySyncResult,
      setSyncing: state.setBoardSyncing,
    })),
  );

  useEffect(() => {
    const unsubscribeResult = onSyncResult(applySyncResult);
    const unsubscribeStatus = onSyncStatus((status, message) => {
      setSyncing(status === "syncing");
      if (status === "error")
        toast({ title: "Sync Failed", description: message, variant: "destructive" });
    });
    void load().catch((error) =>
      toast({
        title: "Could not load saved tasks",
        description: getErrorMessage(error),
        variant: "destructive",
      }),
    );
    return () => {
      unsubscribeResult();
      unsubscribeStatus();
      stopBackgroundSync();
    };
  }, [load, applySyncResult, setSyncing]);

  // Agent runs live in the native core for the whole app lifetime, not per page: subscribe
  // once, then load what the journal already has (runs survive page changes and reloads).
  useEffect(() => {
    const store = useTaskStore.getState();
    const unsubscribe = onRunEvent(store.applyRunEvent);
    void store.loadRuns().catch(() => {});
    void store.loadRepoBindings().catch(() => {});
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (isLoaded && getJiraAccounts().length > 0) startBackgroundSync();
  }, [isLoaded]);

  return (
    <AppErrorBoundary>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <AppUpdater />
        <ResizeHandles />
        <div className="bg-background flex h-screen flex-col overflow-hidden">
          {showCustomTitlebar && <TitleBar />}
          <main className="flex-1 overflow-hidden">
            <HashRouter>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/ai-board" element={<AiBoard />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </HashRouter>
          </main>
        </div>
      </TooltipProvider>
    </AppErrorBoundary>
  );
};

export default App;
