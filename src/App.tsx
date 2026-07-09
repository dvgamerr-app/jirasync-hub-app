import { type MouseEvent, useCallback, useEffect } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { TitleBar } from "@/components/TitleBar";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  startWindowResize,
  usesNativeMacTitlebar,
  type WindowResizeDirection,
} from "@/lib/desktop";
import { startMcpBridge } from "@/lib/mcp-bridge";
import Index from "./pages/Index.tsx";
import Kanban from "./pages/Kanban.tsx";
import KanbanCardPage from "./pages/KanbanCardPage.tsx";
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

  useEffect(() => {
    void startMcpBridge();
  }, []);

  return (
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <ResizeHandles />
      <HashRouter>
        <div className="bg-background flex h-screen flex-col overflow-hidden">
          {showCustomTitlebar && <TitleBar />}
          <div className="flex-1 overflow-hidden">
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/kanban" element={<Kanban />} />
              <Route path="/kanban/new" element={<KanbanCardPage />} />
              <Route path="/kanban/card/:cardId" element={<KanbanCardPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </div>
        </div>
      </HashRouter>
    </TooltipProvider>
  );
};

export default App;
