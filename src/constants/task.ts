import type { TaskType, Severity, StoryLevel } from "@/types/jira";

export const TASK_TYPES: TaskType[] = ["Story", "Bug", "Task"];
export const SEVERITIES: Severity[] = ["Critical", "High", "Medium", "Low", "NA"];
export const STORY_LEVEL_OPTIONS: StoryLevel[] = [1, 2, 3, 5];

export const NO_PENDING_MANDAY = Symbol("no-pending-manday");
