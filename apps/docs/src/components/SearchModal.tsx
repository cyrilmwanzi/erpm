import { useNavigate } from "@tanstack/react-router";
import { BookOpen, CornerDownLeft, Search, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildSearchIndex, type SearchEntry } from "../lib/catalog.js";
import { methodAccentClasses } from "../lib/snippets.js";
import { useDocsApp } from "./ThemeContext.js";

export function SearchModal() {
  const { searchOpen, setSearchOpen } = useDocsApp();
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const index = useMemo(() => buildSearchIndex(), []);

  const results = useMemo<SearchEntry[]>(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return index
        .filter((item) => !item.hash || item.kind === "endpoint")
        .slice(0, 14);
    }
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    return index
      .filter((entry) => tokens.every((tok) => entry.keywords.includes(tok)))
      .slice(0, 24);
  }, [index, query]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query, searchOpen]);

  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => inputRef.current?.focus(), 10);
    } else {
      setQuery("");
    }
  }, [searchOpen]);

  if (!searchOpen) return null;

  const openEntry = (entry: SearchEntry) => {
    setSearchOpen(false);
    void navigate({
      to: entry.to,
      ...(entry.hash ? { hash: entry.hash } : {}),
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setSearchOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === "Enter" && results[selectedIdx]) {
      event.preventDefault();
      openEntry(results[selectedIdx]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 pt-20 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label="Search documentation and API endpoints"
      onClick={() => setSearchOpen(false)}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-[var(--docs-border)] bg-[var(--docs-bg)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-3 border-b border-[var(--docs-border)] px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--docs-text-muted)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search guides, endpoints, HTTP paths, or permissions..."
            className="w-full bg-transparent text-sm text-[var(--docs-text)] placeholder:text-[var(--docs-text-muted)] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setSearchOpen(false)}
            className="rounded p-1 text-[var(--docs-text-muted)] hover:bg-[var(--docs-surface-hover)] hover:text-[var(--docs-text)]"
            aria-label="Close search"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="docs-scroll max-h-[60vh] overflow-y-auto p-2">
          {results.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-[var(--docs-text-muted)]">
              No documentation pages or API endpoints matched &ldquo;{query}&rdquo;.
            </div>
          ) : (
            <ul className="space-y-0.5">
              {results.map((entry, idx) => {
                const isSelected = idx === selectedIdx;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => openEntry(entry)}
                      className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                        isSelected
                          ? "bg-[var(--docs-accent-soft)] text-[var(--docs-text)]"
                          : "text-[var(--docs-text-secondary)] hover:bg-[var(--docs-surface)]"
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        {entry.kind === "guide" ? (
                          <BookOpen className="h-4 w-4 shrink-0 text-[var(--docs-text-muted)]" />
                        ) : (
                          <Terminal className="h-4 w-4 shrink-0 text-[var(--docs-text-muted)]" />
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {entry.httpMethod && (
                              <span
                                className={`font-mono text-xs font-semibold ${methodAccentClasses(
                                  entry.httpMethod,
                                )}`}
                              >
                                {entry.httpMethod}
                              </span>
                            )}
                            <span className="truncate text-sm font-medium text-[var(--docs-text)]">
                              {entry.title}
                            </span>
                          </div>
                          <div className="truncate font-mono text-xs text-[var(--docs-text-muted)]">
                            {entry.subtitle}
                          </div>
                        </div>
                      </div>
                      {isSelected && (
                        <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-[var(--docs-accent)]" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--docs-border)] bg-[var(--docs-surface)] px-4 py-2 text-xs text-[var(--docs-text-muted)]">
          <span>Use arrow keys to navigate, Enter to open</span>
          <span className="font-mono">Esc to close</span>
        </div>
      </div>
    </div>
  );
}
