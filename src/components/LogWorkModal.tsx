import { useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export type LogWorkPayload = {
  taskId: string;
  timeSpentMinutes: number;
  logDate: string;
  comment: string | null;
};

/** 1d = 8h = 480m (standard Jira convention) */
export function parseTimeInput(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  let total = 0;
  const dayMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*d/);
  const hourMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*h/);
  const minMatch = trimmed.match(/(\d+)\s*m/);
  if (dayMatch) total += parseFloat(dayMatch[1]) * 480;
  if (hourMatch) total += parseFloat(hourMatch[1]) * 60;
  if (minMatch) total += parseInt(minMatch[1]);
  if (!dayMatch && !hourMatch && !minMatch) {
    const num = parseFloat(trimmed);
    if (!isNaN(num)) total = num * 60;
    else return null;
  }
  return Math.round(total) || null;
}

export function formatMinutes(minutes: number): string {
  const d = Math.floor(minutes / 480);
  const h = Math.floor((minutes % 480) / 60);
  const m = minutes % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(" ");
}

interface LogWorkModalProps {
  taskId: string;
  onLog: (payload: LogWorkPayload) => void;
  /** "button" = full "Log Time" button (TaskDetailPanel), "inline" = small + icon (TaskTable row) */
  variant?: "button" | "inline";
}

export function LogWorkModal({ taskId, onLog, variant = "button" }: LogWorkModalProps) {
  const [open, setOpen] = useState(false);
  const [timeInput, setTimeInput] = useState("");
  const [date, setDate] = useState<Date>(new Date());
  const [comment, setComment] = useState("");

  const handleSubmit = () => {
    const minutes = parseTimeInput(timeInput);
    if (!minutes || minutes <= 0) {
      toast({
        title: "Invalid time",
        description: "Enter time like '1d 2h 30m', '2h 30m' or '90m'",
        variant: "destructive",
      });
      return;
    }
    onLog({
      taskId,
      timeSpentMinutes: minutes,
      logDate: format(date, "yyyy-MM-dd"),
      comment: comment.trim() || null,
    });
    setTimeInput("");
    setComment("");
    setOpen(false);
  };

  const trigger =
    variant === "inline" ? (
      <button
        className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover:opacity-100"
        title="Log work"
      >
        <Plus className="h-3 w-3" />
      </button>
    ) : (
      <Button variant="outline" size="sm" className="h-7 text-[12px]">
        Log Time
      </Button>
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        className={cn("space-y-3", variant === "inline" ? "w-64" : "w-72")}
        align="end"
      >
        <h4 className="text-[13px] font-semibold">Log Work</h4>

        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">Time Spent</label>
          <Input
            autoFocus
            placeholder="e.g. 1d 2h 30m"
            className="h-8 text-[13px]"
            value={timeInput}
            onChange={(e) => setTimeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">Date</label>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className="h-8 w-full justify-start text-[13px] font-normal"
              >
                <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                {format(date, "PPP")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={date}
                onSelect={(d) => d && setDate(d)}
                initialFocus
                className="pointer-events-auto p-3"
              />
            </PopoverContent>
          </Popover>
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">Comment</label>
          <Textarea
            placeholder="What did you work on?"
            className="min-h-[50px] text-[13px]"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>

        <Button onClick={handleSubmit} className="h-8 w-full text-[13px]">
          Log Work
        </Button>
      </PopoverContent>
    </Popover>
  );
}
