import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Route, Routes } from "react-router-dom";
import { useCallback, useEffect, useRef } from "react";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TitleBar } from "@/components/TitleBar";
import { setWindowSize, lastKnownFrame } from "@/lib/window-rpc";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

type ResizeDir = "e" | "s" | "se";

function ResizeHandles() {
  const startRef = useRef<{ mouseX: number; mouseY: number; startW: number; startH: number; dir: ResizeDir } | null>(null);
  const rafRef = useRef<number | null>(null);

  const onMouseDown = useCallback((dir: ResizeDir) => (e: React.MouseEvent) => {
    e.preventDefault();
    startRef.current = { mouseX: e.screenX, mouseY: e.screenY, startW: lastKnownFrame.width, startH: lastKnownFrame.height, dir };
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const s = startRef.current;
      if (!s) return;
      const dx = e.screenX - s.mouseX;
      const dy = e.screenY - s.mouseY;
      let w = s.startW;
      let h = s.startH;
      if (s.dir === "e" || s.dir === "se") w = Math.max(1200, s.startW + dx);
      if (s.dir === "s" || s.dir === "se") h = Math.max(800, s.startH + dy);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => { setWindowSize(w, h); });
    }
    function onUp() { startRef.current = null; }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  const edge = "fixed z-[9999] select-none";
  return (
    <>
      {/* Right edge */}
      <div className={edge} style={{ top: 0, right: 0, width: 6, bottom: 6, cursor: "e-resize" }} onMouseDown={onMouseDown("e")} />
      {/* Bottom edge */}
      <div className={edge} style={{ bottom: 0, left: 0, right: 6, height: 6, cursor: "s-resize" }} onMouseDown={onMouseDown("s")} />
      {/* Bottom-right corner */}
      <div className={edge} style={{ bottom: 0, right: 0, width: 12, height: 12, cursor: "se-resize" }} onMouseDown={onMouseDown("se")} />
    </>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <ResizeHandles />
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        <TitleBar />
        <div className="flex-1 overflow-hidden">
          <HashRouter>
            <Routes>
              <Route path="/" element={<Index />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </HashRouter>
        </div>
      </div>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
