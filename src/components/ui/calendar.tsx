import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";

import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-2.5", className)}
      classNames={{
        root: "w-fit",
        months: "flex flex-col sm:flex-row",
        month: "relative space-y-3",
        month_caption: "pointer-events-none flex h-8 items-center justify-center px-10",
        caption_label: "text-xs font-semibold tracking-tight",
        nav: "absolute inset-x-0 top-0 z-10 flex h-16 items-center justify-between px-4",
        button_previous: cn(
          buttonVariants({ variant: "outline" }),
          "h-6 w-6 rounded-md border-none bg-transparent p-0 text-muted-foreground opacity-70 hover:bg-accent hover:text-foreground hover:opacity-100",
        ),
        button_next: cn(
          buttonVariants({ variant: "outline" }),
          "h-6 w-6 rounded-md border-none bg-transparent p-0 text-muted-foreground opacity-70 hover:bg-accent hover:text-foreground hover:opacity-100",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "text-muted-foreground rounded-md w-8 font-normal text-[0.72rem]",
        week: "mt-1.5 flex w-full",
        day: "h-8 w-8 p-0 text-center text-xs",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "h-8 w-8 rounded-md p-0 font-normal aria-selected:opacity-100",
        ),
        selected:
          "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
        today: "bg-accent text-accent-foreground rounded-md",
        outside:
          "day-outside text-muted-foreground opacity-50 aria-selected:bg-accent/50 aria-selected:text-muted-foreground aria-selected:opacity-30",
        disabled: "text-muted-foreground opacity-50",
        range_middle: "aria-selected:bg-accent aria-selected:text-accent-foreground",
        range_end: "day-range-end",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          ),
      }}
      {...props}
    />
  );
}
Calendar.displayName = "Calendar";

export { Calendar };
