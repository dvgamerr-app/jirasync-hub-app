import type { MouseEvent } from "react";
import Markdown from "react-markdown";
import { openExternal } from "@/lib/desktop";

interface ReleaseNotesProps {
  markdown: string;
}

function handleLinkClick(event: MouseEvent<HTMLAnchorElement>, href?: string) {
  event.preventDefault();
  if (!href) return;

  try {
    const url = new URL(href);
    if (url.protocol === "https:" || url.protocol === "http:") {
      void openExternal(url.href);
    }
  } catch {
    // Ignore malformed links from release metadata.
  }
}

export function ReleaseNotes({ markdown }: ReleaseNotesProps) {
  const normalizedMarkdown = markdown.replaceAll(
    "https://github.com/$GITHUB_REPOSITORY/",
    "https://github.com/dvgamerr-app/jirasync-hub-app/",
  );

  return (
    <div className="[&_a]:text-primary [&_code]:bg-muted [&_code]:text-foreground [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:px-1 [&_h1]:mt-2 [&_h1]:font-semibold [&_h1:first-child]:mt-0 [&_h2]:mt-2 [&_h2]:font-semibold [&_h2:first-child]:mt-0 [&_h3]:mt-2 [&_h3]:font-semibold [&_h3:first-child]:mt-0 [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:my-1 [&_ul]:my-1">
      <Markdown
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => handleLinkClick(event, href)}
            >
              {children}
            </a>
          ),
        }}
      >
        {normalizedMarkdown}
      </Markdown>
    </div>
  );
}
