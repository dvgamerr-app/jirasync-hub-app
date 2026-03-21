import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type MouseEvent, useCallback } from "react";
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
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

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

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <ResizeHandles />
        <div className="flex h-screen flex-col overflow-hidden bg-background">
          {showCustomTitlebar && <TitleBar />}
          <div className="flex-1 overflow-hidden">
            <HashRouter>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </HashRouter>
          </div>
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
