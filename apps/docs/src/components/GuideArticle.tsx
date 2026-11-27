import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { GUIDE_PAGES, type GuidePage } from "../data/guides.js";
import { CodeBlock } from "./CodeBlock.js";

export function GuideArticle({ guide }: { guide: GuidePage }) {
  const currentIdx = GUIDE_PAGES.findIndex((g) => g.slug === guide.slug);
  const prevGuide = currentIdx > 0 ? GUIDE_PAGES[currentIdx - 1] : undefined;
  const nextGuide =
    currentIdx >= 0 && currentIdx < GUIDE_PAGES.length - 1
      ? GUIDE_PAGES[currentIdx + 1]
      : undefined;

  return (
    <article className="mx-auto max-w-[74ch]">
      <header className="mb-10">
        <div className="mb-2 text-xs font-medium text-[var(--docs-accent)]">
          {guide.groupTitle}
        </div>
        <h1 className="font-display text-3xl font-bold tracking-tight text-[var(--docs-text)] sm:text-[34px]">
          {guide.title}
        </h1>
        <p className="mt-4 text-[15.5px] leading-7 text-[var(--docs-text-secondary)]">
          {guide.lead}
        </p>
      </header>

      <div className="space-y-10">
        {guide.sections.map((section) => (
          <section key={section.id} id={section.id} className="scroll-mt-24">
            <h2 className="font-display text-[22px] font-bold tracking-tight text-[var(--docs-text)]">
              {section.heading}
            </h2>

            {section.paragraphs && (
              <div className="mt-3 space-y-3 text-[15px] leading-7 text-[var(--docs-text-secondary)]">
                {section.paragraphs.map((p, idx) => (
                  <p key={idx}>{p}</p>
                ))}
              </div>
            )}

            {section.definitions && (
              <div className="mt-5 space-y-4 text-[15px] leading-7 text-[var(--docs-text-secondary)]">
                {section.definitions.map((def) => (
                  <p key={def.term}>
                    <strong className="font-semibold text-[var(--docs-text)]">
                      {def.term}:{" "}
                    </strong>
                    {def.description}
                  </p>
                ))}
              </div>
            )}

            {section.bullets && (
              <ul className="mt-4 list-disc space-y-2 pl-5 text-[15px] leading-7 text-[var(--docs-text-secondary)]">
                {section.bullets.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            )}

            {section.table && (
              <div className="mt-5 overflow-x-auto rounded-lg border border-[var(--docs-border)]">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--docs-border)] bg-[var(--docs-surface)]">
                      {section.table.headers.map((header) => (
                        <th
                          key={header}
                          className="px-4 py-2.5 font-semibold text-[var(--docs-text)] whitespace-nowrap"
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--docs-border-subtle)]">
                    {section.table.rows.map((row, rowIdx) => (
                      <tr
                        key={rowIdx}
                        className="hover:bg-[var(--docs-surface)]/70"
                      >
                        {row.map((cell, cellIdx) => (
                          <td
                            key={cellIdx}
                            className={`px-4 py-2.5 align-top leading-6 ${
                              cellIdx === 0
                                ? "font-mono text-xs font-medium text-[var(--docs-text)] whitespace-nowrap"
                                : "text-[var(--docs-text-secondary)]"
                            }`}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {section.callout && (
              <div className="mt-5 rounded-lg border border-[var(--docs-border)] bg-[var(--docs-surface)] px-4 py-3.5">
                <div className="text-xs font-semibold text-[var(--docs-text)]">
                  {section.callout.title}
                </div>
                <p className="mt-1 text-sm leading-6 text-[var(--docs-text-secondary)]">
                  {section.callout.body}
                </p>
              </div>
            )}

            {section.codeBlocks && (
              <div className="mt-5 space-y-4">
                {section.codeBlocks.map((block, idx) => (
                  <CodeBlock
                    key={idx}
                    language={block.language}
                    label={block.label}
                    code={block.code}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      <footer className="mt-14 flex items-center justify-between gap-4 border-t border-[var(--docs-border)] pt-6">
        {prevGuide ? (
          <Link
            to="/docs/$slug"
            params={{ slug: prevGuide.slug }}
            className="group flex flex-col gap-1 rounded-lg border border-[var(--docs-border)] px-4 py-3 transition-colors hover:border-[var(--docs-accent)]"
          >
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--docs-text-muted)]">
              <ArrowLeft className="h-3.5 w-3.5" />
              Previous
            </span>
            <span className="text-sm font-medium text-[var(--docs-text)] group-hover:text-[var(--docs-accent)]">
              {prevGuide.title}
            </span>
          </Link>
        ) : (
          <div />
        )}

        {nextGuide && (
          <Link
            to="/docs/$slug"
            params={{ slug: nextGuide.slug }}
            className="group flex flex-col items-end gap-1 rounded-lg border border-[var(--docs-border)] px-4 py-3 text-right transition-colors hover:border-[var(--docs-accent)]"
          >
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--docs-text-muted)]">
              Next
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
            <span className="text-sm font-medium text-[var(--docs-text)] group-hover:text-[var(--docs-accent)]">
              {nextGuide.title}
            </span>
          </Link>
        )}
      </footer>
    </article>
  );
}
