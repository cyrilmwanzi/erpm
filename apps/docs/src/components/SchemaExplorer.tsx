import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { SchemaFieldDoc } from "../generated/api-types.js";

function SchemaFieldRow({
  field,
  depth = 0,
}: {
  field: SchemaFieldDoc;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = Boolean(field.children && field.children.length > 0);

  return (
    <div className="border-b border-[var(--docs-border-subtle)] last:border-b-0">
      <div
        className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          {hasChildren ? (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-[var(--docs-text)] hover:text-[var(--docs-accent)]"
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-[var(--docs-text-muted)]" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-[var(--docs-text-muted)]" />
              )}
              <span>{field.name}</span>
            </button>
          ) : (
            <span className="font-mono text-xs font-semibold text-[var(--docs-text)]">
              {field.name}
            </span>
          )}

          <span className="font-mono text-xs text-[var(--docs-text-muted)]">
            {field.type}
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs text-[var(--docs-text-muted)] shrink-0">
          <span
            className={
              field.required
                ? "font-medium text-amber-700 dark:text-amber-400"
                : "text-[var(--docs-text-muted)]"
            }
          >
            {field.required ? "required" : "optional"}
          </span>
          {field.nullable && (
            <>
              <span aria-hidden="true">·</span>
              <span>nullable</span>
            </>
          )}
        </div>
      </div>

      {field.enumValues && field.enumValues.length > 0 && (
        <div
          className="pb-2 font-mono text-[11px] text-[var(--docs-text-muted)]"
          style={{ paddingLeft: `${depth * 16}px` }}
        >
          Allowed: {field.enumValues.join(" | ")}
        </div>
      )}

      {hasChildren && expanded && (
        <div className="border-t border-[var(--docs-border-subtle)] bg-[var(--docs-surface)]/50 px-3">
          {field.children!.map((child) => (
            <SchemaFieldRow
              key={`${field.name}.${child.name}`}
              field={child}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SchemaExplorer({
  fields,
  emptyLabel,
  rawType,
}: {
  fields: SchemaFieldDoc[];
  emptyLabel: string;
  rawType?: string | null;
}) {
  const [showRaw, setShowRaw] = useState(false);

  if (fields.length === 0 && !rawType) {
    return (
      <div className="py-4 text-xs text-[var(--docs-text-muted)]">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div>
      {rawType && (
        <div className="mb-2 flex items-center justify-end">
          <button
            type="button"
            onClick={() => setShowRaw((prev) => !prev)}
            className="text-xs font-medium text-[var(--docs-accent)] hover:underline"
          >
            {showRaw ? "View structured fields" : "View TypeScript definition"}
          </button>
        </div>
      )}

      {showRaw && rawType ? (
        <pre className="docs-scroll max-h-72 overflow-auto rounded-lg border border-[var(--docs-border)] bg-[var(--docs-surface)] p-3 font-mono text-xs leading-5 text-[var(--docs-text-secondary)]">
          {rawType}
        </pre>
      ) : fields.length > 0 ? (
        <div className="rounded-lg border border-[var(--docs-border)] bg-[var(--docs-bg)] px-4">
          {fields.map((field) => (
            <SchemaFieldRow key={field.name} field={field} />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--docs-border)] bg-[var(--docs-surface)] px-3.5 py-2.5 font-mono text-xs text-[var(--docs-text-secondary)]">
          {rawType}
        </div>
      )}
    </div>
  );
}
