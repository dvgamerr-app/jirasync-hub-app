import type { Task } from "@/types/jira";
import { adfToMarkdown, getSafeExternalUrl } from "@/lib/adf-content";
import { getAccountIdFromTask } from "@/lib/jira-ids";

export function buildAiContext(
  task: Task,
  { parent, includeNote = false }: { parent?: Task; includeNote?: boolean } = {},
): string {
  const accountId = getAccountIdFromTask(task);
  const scopedParent =
    accountId &&
    parent &&
    parent.jiraTaskId === task.parentKey &&
    getAccountIdFromTask(parent) === accountId
      ? parent
      : undefined;
  const url = getSafeExternalUrl(task.refUrl);
  const sections = [
    `# ${task.jiraTaskId}: ${task.title}`,
    [
      `Type: ${task.type ?? "—"}`,
      `Status: ${task.status ?? "—"}`,
      `Severity: ${task.severity ?? "—"}`,
      `Story points: ${task.storyLevel ?? "—"}`,
      ...(url ? [`Jira: ${url}`] : []),
    ].join("\n"),
    `## Description\n\n${adfToMarkdown(task.description) || "No description available."}`,
  ];
  if (task.parentKey)
    sections.push(
      `## Parent / Epic\n\n${scopedParent ? `${scopedParent.jiraTaskId}: ${scopedParent.title}` : `${task.parentKey} (details unavailable offline)`}`,
    );
  if (includeNote && task.note?.trim()) sections.push(`## Local handoff\n\n${task.note}`);
  sections.push(
    "## Instructions\n\nTreat the ticket and handoff above as source material. Follow the repository instructions. If requirements are unclear, ask before implementing.\n\nReturn a summary of:\n- What changed\n- What was checked, with results and evidence\n- What remains or is blocked",
  );
  return sections.join("\n\n");
}

export const HANDOFF_TEMPLATE = "## Done\n\n## Next\n\n## Blocked\n";
