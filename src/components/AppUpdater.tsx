import { useCallback, useEffect, useRef, useState } from "react";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { CheckCircle2, Download, Loader2, RefreshCw, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  AUTO_UPDATE_CHANGED_EVENT,
  getAutoUpdateEnabled,
  UPDATE_CHECK_REQUEST_EVENT,
} from "@/lib/app-updater";
import { isTauriRuntime, isWindows } from "@/lib/desktop";

type UpdatePhase =
  | "hidden"
  | "checking"
  | "available"
  | "downloading"
  | "ready-to-install"
  | "installing"
  | "ready-to-restart"
  | "up-to-date"
  | "error";

const AUTO_CHECK_DELAY_MS = 1_500;
const CHECK_TIMEOUT_MS = 30_000;
const TRANSIENT_NOTICE_MS = 5_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AppUpdater() {
  const updateRef = useRef<Update | null>(null);
  const checkingRef = useRef(false);
  const transientTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("hidden");
  const [version, setVersion] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  const clearTransientTimer = useCallback(() => {
    if (transientTimerRef.current) {
      clearTimeout(transientTimerRef.current);
      transientTimerRef.current = null;
    }
  }, []);

  const showTransientPhase = useCallback(
    (nextPhase: "up-to-date" | "error") => {
      clearTransientTimer();
      setPhase(nextPhase);
      transientTimerRef.current = setTimeout(() => setPhase("hidden"), TRANSIENT_NOTICE_MS);
    },
    [clearTransientTimer],
  );

  const checkForUpdates = useCallback(
    async (manual: boolean) => {
      if (!isTauriRuntime() || checkingRef.current) return;

      checkingRef.current = true;
      clearTransientTimer();
      if (manual) setPhase("checking");

      try {
        const nextUpdate = await check({ timeout: CHECK_TIMEOUT_MS });
        if (!nextUpdate) {
          if (manual) showTransientPhase("up-to-date");
          return;
        }

        if (updateRef.current && updateRef.current !== nextUpdate) {
          void updateRef.current.close();
        }
        updateRef.current = nextUpdate;
        setVersion(nextUpdate.version);
        setReleaseNotes(nextUpdate.body ?? "");
        setProgress(0);
        setError("");
        setPhase("available");
      } catch (checkError) {
        console.warn("Unable to check for app updates", checkError);
        if (manual) {
          setError(errorMessage(checkError));
          showTransientPhase("error");
        }
      } finally {
        checkingRef.current = false;
      }
    },
    [clearTransientTimer, showTransientPhase],
  );

  useEffect(() => {
    if (!isTauriRuntime()) return;

    const requestCheck = () => void checkForUpdates(true);
    const preferenceChanged = (event: Event) => {
      if ((event as CustomEvent<boolean>).detail) {
        void checkForUpdates(true);
      }
    };

    window.addEventListener(UPDATE_CHECK_REQUEST_EVENT, requestCheck);
    window.addEventListener(AUTO_UPDATE_CHANGED_EVENT, preferenceChanged);

    const timer = getAutoUpdateEnabled()
      ? setTimeout(() => void checkForUpdates(false), AUTO_CHECK_DELAY_MS)
      : null;

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener(UPDATE_CHECK_REQUEST_EVENT, requestCheck);
      window.removeEventListener(AUTO_UPDATE_CHANGED_EVENT, preferenceChanged);
    };
  }, [checkForUpdates]);

  useEffect(
    () => () => {
      clearTransientTimer();
      if (updateRef.current) void updateRef.current.close();
    },
    [clearTransientTimer],
  );

  const handleDownloadAndInstall = async () => {
    const update = updateRef.current;
    if (!update) return;

    setPhase("downloading");
    setProgress(0);
    setError("");

    let downloaded = 0;
    let contentLength = 0;
    const onDownload = (event: DownloadEvent) => {
      if (event.event === "Started") {
        contentLength = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (contentLength > 0) {
          setProgress(Math.min(100, Math.round((downloaded / contentLength) * 100)));
        }
      } else {
        setProgress(100);
      }
    };

    try {
      await update.download(onDownload, { timeout: 10 * 60_000 });

      if (isWindows()) {
        // Tauri's Windows installer must exit the running app during installation.
        // Let the user choose when that interruption happens.
        setPhase("ready-to-install");
        return;
      }

      setPhase("installing");
      await update.install();
      setPhase("ready-to-restart");
    } catch (installError) {
      setError(errorMessage(installError));
      setPhase("error");
    }
  };

  const handleRestart = async () => {
    const update = updateRef.current;
    if (!update) return;

    try {
      if (phase === "ready-to-install") {
        setPhase("installing");
        await update.install();
      }
      await relaunch();
    } catch (restartError) {
      setError(errorMessage(restartError));
      setPhase("error");
    }
  };

  const handleDismiss = () => {
    clearTransientTimer();
    setPhase("hidden");
  };

  if (phase === "hidden") return null;

  const isBusy = phase === "checking" || phase === "downloading" || phase === "installing";

  return (
    <aside
      aria-live="polite"
      aria-label="Application update"
      className="border-border bg-background fixed right-4 bottom-4 z-[110] w-[min(380px,calc(100vw-2rem))] rounded-xl border p-4 shadow-2xl"
    >
      <button
        type="button"
        aria-label="Dismiss update notification"
        className="text-muted-foreground hover:text-foreground absolute top-2.5 right-2.5 rounded-md p-1"
        onClick={handleDismiss}
        disabled={isBusy}
      >
        <X className="h-4 w-4" />
      </button>

      <div className="flex gap-3 pr-5">
        <div className="bg-primary/10 text-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          {phase === "checking" || phase === "downloading" || phase === "installing" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : phase === "up-to-date" ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : phase === "error" ? (
            <RefreshCw className="h-4 w-4" />
          ) : phase === "ready-to-install" || phase === "ready-to-restart" ? (
            <RotateCcw className="h-4 w-4" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {phase === "checking" && "Checking for updates…"}
            {phase === "available" && `Version ${version} is available`}
            {phase === "downloading" && `Downloading version ${version}…`}
            {phase === "ready-to-install" && "Ready to restart and update"}
            {phase === "installing" && "Installing update…"}
            {phase === "ready-to-restart" && "Update installed"}
            {phase === "up-to-date" && "You’re up to date"}
            {phase === "error" && "Update failed"}
          </p>

          {phase === "available" && (
            <p className="text-muted-foreground mt-1 max-h-16 overflow-hidden text-xs leading-5">
              {releaseNotes || "Download the latest version of JiraSync Hub."}
            </p>
          )}
          {phase === "ready-to-install" && (
            <p className="text-muted-foreground mt-1 text-xs leading-5">
              The update has downloaded. JiraSync Hub will close briefly while Windows installs it.
            </p>
          )}
          {phase === "ready-to-restart" && (
            <p className="text-muted-foreground mt-1 text-xs leading-5">
              Restart JiraSync Hub now to use version {version}.
            </p>
          )}
          {phase === "up-to-date" && (
            <p className="text-muted-foreground mt-1 text-xs">No newer version is available.</p>
          )}
          {phase === "error" && (
            <p className="text-destructive mt-1 max-h-16 overflow-hidden text-xs leading-5">
              {error || "Could not complete the update. Please try again."}
            </p>
          )}

          {phase === "downloading" && (
            <div className="mt-3 space-y-1.5">
              <Progress value={progress} className="h-1.5" />
              <p className="text-muted-foreground text-right text-[11px] tabular-nums">
                {progress > 0 ? `${progress}%` : "Starting download…"}
              </p>
            </div>
          )}

          <div className="mt-3 flex gap-2">
            {phase === "available" && (
              <>
                <Button size="sm" className="h-8 text-xs" onClick={handleDownloadAndInstall}>
                  Update now
                </Button>
                <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={handleDismiss}>
                  Later
                </Button>
              </>
            )}
            {(phase === "ready-to-install" || phase === "ready-to-restart") && (
              <>
                <Button size="sm" className="h-8 text-xs" onClick={handleRestart}>
                  {phase === "ready-to-install" ? "Restart to update" : "Restart now"}
                </Button>
                <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={handleDismiss}>
                  Later
                </Button>
              </>
            )}
            {phase === "error" && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => void checkForUpdates(true)}
              >
                Try again
              </Button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
