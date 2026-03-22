/**
 * Atlassian Document Format (ADF) renderer
 * Renders structured Jira descriptions as rich HTML matching Jira's visual style.
 *
 * Falls back to plain-text rendering for legacy stored strings.
 */
import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { Info, FileText, AlertTriangle, AlertCircle, CheckCircle2 } from "lucide-react";

// ── ADF types ─────────────────────────────────────────────────────────────────

type AdfMark = {
  type: string;
  attrs?: Record<string, unknown>;
};

type AdfNode = {
  type: string;
  text?: string;
  marks?: AdfMark[];
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
};

function parseAdfDocument(content: string): AdfNode | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && parsed.type === "doc") {
      return parsed as AdfNode;
    }
  } catch {
    // Not JSON — fall through to plain text
  }
  return null;
}

// ── Mark rendering ─────────────────────────────────────────────────────────────

function applyMarks(text: string, marks?: AdfMark[]): React.ReactNode {
  if (!marks || marks.length === 0) return text;
  let node: React.ReactNode = text;
  for (const mark of marks) {
    switch (mark.type) {
      case "strong":
        node = <strong className="font-semibold">{node}</strong>;
        break;
      case "em":
        node = <em>{node}</em>;
        break;
      case "code":
        node = (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground">
            {node}
          </code>
        );
        break;
      case "strike":
        node = <s>{node}</s>;
        break;
      case "underline":
        node = <u>{node}</u>;
        break;
      case "link": {
        const href = mark.attrs?.href as string | undefined;
        node = (
          <a
            href={href}
            className="text-primary underline hover:opacity-80"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {node}
          </a>
        );
        break;
      }
      case "textColor":
        node = <span style={{ color: mark.attrs?.color as string }}>{node}</span>;
        break;
      case "subsup":
        node = mark.attrs?.type === "sub" ? <sub>{node}</sub> : <sup>{node}</sup>;
        break;
    }
  }
  return node;
}

// ── Heading sizes ──────────────────────────────────────────────────────────────

const HEADING_CLASSES: Record<number, string> = {
  1: "mt-4 mb-2 text-xl font-bold leading-tight",
  2: "mt-3 mb-1.5 text-lg font-bold leading-tight",
  3: "mt-2.5 mb-1 text-base font-semibold leading-snug",
  4: "text-[14px] font-semibold",
  5: "text-[13px] font-semibold",
  6: "text-[12px] font-semibold text-muted-foreground",
};

// ── Panel config ───────────────────────────────────────────────────────────────

const PANEL_CONFIG: Record<string, { border: string; bg: string; icon: React.ReactNode }> = {
  info: {
    border: "border-blue-400",
    bg: "bg-blue-50 dark:bg-blue-950/30",
    icon: <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />,
  },
  note: {
    border: "border-purple-400",
    bg: "bg-purple-50 dark:bg-purple-950/30",
    icon: <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-purple-500" />,
  },
  warning: {
    border: "border-yellow-400",
    bg: "bg-yellow-50 dark:bg-yellow-950/30",
    icon: <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-500" />,
  },
  error: {
    border: "border-red-400",
    bg: "bg-red-50 dark:bg-red-950/30",
    icon: <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />,
  },
  success: {
    border: "border-green-400",
    bg: "bg-green-50 dark:bg-green-950/30",
    icon: <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />,
  },
};

// ── Node renderer ──────────────────────────────────────────────────────────────

function renderNode(node: AdfNode, key: number): React.ReactNode {
  switch (node.type) {
    // ── Block: paragraph ──────────────────────────────────────────────────────
    case "paragraph": {
      if (!node.content || node.content.length === 0) return <br key={key} />;
      return (
        <p key={key} className="text-[13px] leading-relaxed">
          {node.content.map((child, i) => renderNode(child, i))}
        </p>
      );
    }

    // ── Block: headings ───────────────────────────────────────────────────────
    case "heading": {
      const level = (node.attrs?.level as number) ?? 1;
      const cls = HEADING_CLASSES[Math.min(level, 6)] ?? HEADING_CLASSES[1];
      const children = node.content?.map((child, i) => renderNode(child, i));
      switch (level) {
        case 1:
          return (
            <h1 key={key} className={cls}>
              {children}
            </h1>
          );
        case 2:
          return (
            <h2 key={key} className={cls}>
              {children}
            </h2>
          );
        case 3:
          return (
            <h3 key={key} className={cls}>
              {children}
            </h3>
          );
        case 4:
          return (
            <h4 key={key} className={cls}>
              {children}
            </h4>
          );
        case 5:
          return (
            <h5 key={key} className={cls}>
              {children}
            </h5>
          );
        default:
          return (
            <h6 key={key} className={cls}>
              {children}
            </h6>
          );
      }
    }

    // ── Inline: text ──────────────────────────────────────────────────────────
    case "text":
      return <Fragment key={key}>{applyMarks(node.text ?? "", node.marks)}</Fragment>;

    // ── Inline: hard break ────────────────────────────────────────────────────
    case "hardBreak":
      return <br key={key} />;

    // ── Block: lists ──────────────────────────────────────────────────────────
    case "bulletList":
      return (
        <ul key={key} className="my-1 ml-5 list-disc space-y-0.5 text-[13px]">
          {node.content?.map((child, i) => renderNode(child, i))}
        </ul>
      );

    case "orderedList":
      return (
        <ol
          key={key}
          className="my-1 ml-5 list-decimal space-y-0.5 text-[13px]"
          start={node.attrs?.order as number | undefined}
        >
          {node.content?.map((child, i) => renderNode(child, i))}
        </ol>
      );

    case "listItem":
      return (
        <li key={key} className="leading-relaxed [&>p]:m-0 [&>p]:inline">
          {node.content?.map((child, i) => renderNode(child, i))}
        </li>
      );

    // ── Block: blockquote ─────────────────────────────────────────────────────
    case "blockquote":
      return (
        <blockquote
          key={key}
          className="border-l-[3px] border-border pl-3 text-[13px] italic text-muted-foreground [&>p]:m-0"
        >
          {node.content?.map((child, i) => renderNode(child, i))}
        </blockquote>
      );

    // ── Block: code block ─────────────────────────────────────────────────────
    case "codeBlock": {
      const lang = node.attrs?.language as string | undefined;
      const code = node.content?.map((c) => c.text ?? "").join("") ?? "";
      return (
        <pre
          key={key}
          className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-[12px] leading-relaxed"
        >
          {lang && (
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {lang}
            </div>
          )}
          <code>{code}</code>
        </pre>
      );
    }

    // ── Block: horizontal rule ────────────────────────────────────────────────
    case "rule":
      return <hr key={key} className="my-3 border-border" />;

    // ── Block: panel (info / note / warning / error / success) ───────────────
    case "panel": {
      const panelType = (node.attrs?.panelType as string) ?? "info";
      const cfg = PANEL_CONFIG[panelType] ?? PANEL_CONFIG.info;
      return (
        <div
          key={key}
          className={cn(
            "my-1.5 flex gap-2 rounded-md border-l-4 px-3 py-2.5 text-[13px]",
            cfg.border,
            cfg.bg,
          )}
        >
          {cfg.icon}
          <div className="min-w-0 flex-1 [&>p]:m-0">
            {node.content?.map((child, i) => renderNode(child, i))}
          </div>
        </div>
      );
    }

    // ── Inline: mention ───────────────────────────────────────────────────────
    case "mention":
      return (
        <span
          key={key}
          className="rounded bg-primary/10 px-1 py-0.5 text-[12px] font-medium text-primary"
        >
          @{(node.attrs?.text as string) ?? (node.attrs?.id as string)}
        </span>
      );

    // ── Inline: emoji ─────────────────────────────────────────────────────────
    case "emoji":
      return (
        <span key={key} title={node.attrs?.shortName as string}>
          {(node.attrs?.text as string) ?? (node.attrs?.shortName as string)}
        </span>
      );

    // ── Inline: status lozenge ────────────────────────────────────────────────
    case "status":
      return (
        <span
          key={key}
          className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide"
        >
          {node.attrs?.text as string}
        </span>
      );

    // ── Inline / block: card links ────────────────────────────────────────────
    case "inlineCard":
    case "blockCard": {
      const url = node.attrs?.url as string;
      return (
        <a
          key={key}
          href={url}
          className="break-all text-[13px] text-primary underline hover:opacity-80"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {url}
        </a>
      );
    }

    // ── Block: table ──────────────────────────────────────────────────────────
    case "table":
      return (
        <div key={key} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <tbody>{node.content?.map((child, i) => renderNode(child, i))}</tbody>
          </table>
        </div>
      );

    case "tableRow":
      return <tr key={key}>{node.content?.map((child, i) => renderNode(child, i))}</tr>;

    case "tableHeader":
      return (
        <th
          key={key}
          className="border border-border bg-muted/70 px-2 py-1.5 text-left text-[12px] font-semibold"
          colSpan={node.attrs?.colspan as number | undefined}
          rowSpan={node.attrs?.rowspan as number | undefined}
        >
          {node.content?.map((child, i) => renderNode(child, i))}
        </th>
      );

    case "tableCell":
      return (
        <td
          key={key}
          className="border border-border px-2 py-1.5 align-top [&>p]:m-0"
          colSpan={node.attrs?.colspan as number | undefined}
          rowSpan={node.attrs?.rowspan as number | undefined}
        >
          {node.content?.map((child, i) => renderNode(child, i))}
        </td>
      );

    // ── Block: media ──────────────────────────────────────────────────────────
    case "mediaSingle":
    case "mediaGroup":
      return (
        <div key={key} className="my-2">
          {node.content?.map((child, i) => renderNode(child, i))}
        </div>
      );

    case "media":
      return (
        <div
          key={key}
          className="flex h-10 items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-3 text-[12px] text-muted-foreground"
        >
          📎 {node.attrs?.type === "file" ? "File attachment" : "Media"}
        </div>
      );

    // ── Block: expand / nested expand ─────────────────────────────────────────
    case "expand":
    case "nestedExpand": {
      const title = node.attrs?.title as string | undefined;
      return (
        <details key={key} className="my-1.5 rounded-md border border-border">
          <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium hover:bg-muted/40">
            {title || "Details"}
          </summary>
          <div className="px-3 pb-2 pt-1">
            {node.content?.map((child, i) => renderNode(child, i))}
          </div>
        </details>
      );
    }

    // ── Fallback ──────────────────────────────────────────────────────────────
    default:
      if (node.content) {
        return (
          <Fragment key={key}>{node.content.map((child, i) => renderNode(child, i))}</Fragment>
        );
      }
      if (node.text) {
        return <Fragment key={key}>{applyMarks(node.text, node.marks)}</Fragment>;
      }
      return null;
  }
}

// ── Public component ──────────────────────────────────────────────────────────

interface AdfRendererProps {
  /** Raw ADF JSON string (from Jira API v3) or legacy plain-text description */
  content: string;
  className?: string;
}

export function AdfRenderer({ content, className }: AdfRendererProps) {
  const normalizedContent = content.trim();
  const adf = parseAdfDocument(normalizedContent);

  if (adf) {
    return (
      <div className={cn("text-[13px] leading-relaxed text-foreground", className)}>
        {adf.content?.map((child, i) => renderNode(child, i))}
      </div>
    );
  }

  // ── Plain-text fallback ───────────────────────────────────────────────────
  const paragraphs = normalizedContent.split(/\n{2,}/).filter(Boolean);
  return (
    <div className={cn("space-y-2 text-[13px] leading-relaxed text-muted-foreground", className)}>
      {paragraphs.map((para, i) => (
        <p key={i}>
          {para.split("\n").map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {line}
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}
