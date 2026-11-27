import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Menu, Moon, Search, Sun, X } from "lucide-react";
import { useMemo, useState } from "react";
import { GUIDE_GROUPS } from "../data/guides.js";
import { getCategorizedNamespaces } from "../lib/catalog.js";
import { methodAccentClasses } from "../lib/snippets.js";
import { CredentialsModal } from "./CredentialsModal.js";
import { SearchModal } from "./SearchModal.js";
import { useDocsApp } from "./ThemeContext.js";

export interface TocItem {
  id: string;
  label: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
}

interface DocsShellProps {
  children: React.ReactNode;
  tocItems?: TocItem[];
  tocTitle?: string;
}

function ScaceBrandMark() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <circle cx="9.5" cy="12" r="6.5" stroke="#2563EB" strokeWidth="3" />
      <circle cx="15.5" cy="12" r="5" stroke="#60A5FA" strokeWidth="2.5" />
    </svg>
  );
}

export function DocsShell({
  children,
  tocItems = [],
  tocTitle = "On this page",
}: DocsShellProps) {
  const {
    theme,
    toggleTheme,
    setSearchOpen,
    setCredentialsOpen,
    credentials,
  } = useDocsApp();

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const apiCategories = useMemo(() => getCategorizedNamespaces(), []);

  const [openGuideGroups, setOpenGuideGroups] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const g of GUIDE_GROUPS) {
      initial[g.id] = Boolean(g.defaultOpen);
    }
    return initial;
  });

  const [openApiCategories, setOpenApiCategories] = useState<
    Record<string, boolean>
  >({
    "Identity & Access": true,
    "Organization & Governance": true,
    "Billing & Payments": true,
  });

  const activeGuideSlug = pathname.startsWith("/docs/")
    ? pathname.slice("/docs/".length)
    : null;
  const activeApiSlug = pathname.startsWith("/api/")
    ? pathname.slice("/api/".length)
    : null;

  const isGuideGroupExpanded = (groupId: string, items: { slug: string }[]) => {
    if (activeGuideSlug && items.some((i) => i.slug === activeGuideSlug)) {
      return true;
    }
    return Boolean(openGuideGroups[groupId]);
  };

  const isApiCatExpanded = (
    category: string,
    namespaces: { slug: string }[],
  ) => {
    if (activeApiSlug && namespaces.some((n) => n.slug === activeApiSlug)) {
      return true;
    }
    return Boolean(openApiCategories[category]);
  };

  const toggleGuideGroup = (groupId: string) => {
    setOpenGuideGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const toggleApiCategory = (category: string) => {
    setOpenApiCategories((prev) => ({ ...prev, [category]: !prev[category] }));
  };

  const sidebarContent = (
    <nav
      aria-label="Documentation navigation"
      className="space-y-6 px-5 py-6 text-[13.5px]"
    >
      <div>
        <ul className="space-y-1">
          {GUIDE_GROUPS.map((group) => {
            const expanded = isGuideGroupExpanded(group.id, group.items);
            return (
              <li key={group.id}>
                <button
                  type="button"
                  onClick={() => toggleGuideGroup(group.id)}
                  className="flex w-full items-center justify-between rounded-md py-2 text-left font-medium text-[var(--docs-text)] transition-colors hover:text-[var(--docs-accent)]"
                >
                  <span className="truncate">{group.title}</span>
                  {expanded ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--docs-text-muted)]" />
                  ) : (
                    <ChevronUp className="h-3.5 w-3.5 shrink-0 text-[var(--docs-text-muted)]" />
                  )}
                </button>

                {expanded && (
                  <ul className="relative ml-2.5 mt-1 mb-2 space-y-0.5 pl-4 before:absolute before:left-[3px] before:top-2.5 before:bottom-2.5 before:w-px before:bg-[var(--docs-border)]">
                    {group.items.map((item) => {
                      const isActive = activeGuideSlug === item.slug;
                      return (
                        <li key={item.slug} className="relative">
                          <span
                            aria-hidden="true"
                            className={`absolute -left-4 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full transition-colors ${
                              isActive
                                ? "bg-[var(--docs-accent)]"
                                : "bg-slate-400/70 dark:bg-slate-600"
                            }`}
                          />
                          <Link
                            to="/docs/$slug"
                            params={{ slug: item.slug }}
                            onClick={() => setMobileMenuOpen(false)}
                            className={`block rounded py-1.5 text-[13px] transition-colors ${
                              isActive
                                ? "font-medium text-[var(--docs-accent)]"
                                : "text-[var(--docs-text-muted)] hover:text-[var(--docs-text)]"
                            }`}
                          >
                            {item.title}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="border-t border-[var(--docs-border)] pt-5">
        <div className="mb-2 flex items-center justify-between">
          <Link
            to="/api"
            onClick={() => setMobileMenuOpen(false)}
            className={`text-xs font-semibold uppercase tracking-wider transition-colors ${
              pathname === "/api"
                ? "text-[var(--docs-accent)]"
                : "text-[var(--docs-text-muted)] hover:text-[var(--docs-text)]"
            }`}
          >
            API Reference
          </Link>
        </div>

        <ul className="space-y-1">
          {apiCategories.map((cat) => {
            const expanded = isApiCatExpanded(cat.category, cat.namespaces);
            return (
              <li key={cat.category}>
                <button
                  type="button"
                  onClick={() => toggleApiCategory(cat.category)}
                  className="flex w-full items-center justify-between rounded-md py-1.5 text-left text-[13px] font-medium text-[var(--docs-text)] transition-colors hover:text-[var(--docs-accent)]"
                >
                  <span className="truncate">{cat.category}</span>
                  {expanded ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--docs-text-muted)]" />
                  ) : (
                    <ChevronUp className="h-3.5 w-3.5 shrink-0 text-[var(--docs-text-muted)]" />
                  )}
                </button>

                {expanded && (
                  <ul className="relative ml-2.5 mt-0.5 mb-2 space-y-0.5 pl-4 before:absolute before:left-[3px] before:top-2.5 before:bottom-2.5 before:w-px before:bg-[var(--docs-border)]">
                    {cat.namespaces.map((ns) => {
                      const isActive = activeApiSlug === ns.slug;
                      return (
                        <li key={ns.slug} className="relative">
                          <span
                            aria-hidden="true"
                            className={`absolute -left-4 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full ${
                              isActive
                                ? "bg-[var(--docs-accent)]"
                                : "bg-slate-400/70 dark:bg-slate-600"
                            }`}
                          />
                          <Link
                            to="/api/$namespace"
                            params={{ namespace: ns.slug }}
                            onClick={() => setMobileMenuOpen(false)}
                            className={`flex items-center justify-between gap-2 rounded py-1 text-[13px] transition-colors ${
                              isActive
                                ? "font-medium text-[var(--docs-accent)]"
                                : "text-[var(--docs-text-muted)] hover:text-[var(--docs-text)]"
                            }`}
                          >
                            <span className="truncate">{ns.title}</span>
                            <span className="font-mono text-[11px] tabular-nums opacity-70">
                              {ns.endpointCount}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-[var(--docs-bg)] text-[var(--docs-text)]">
      {/* Top Bar */}
      <header className="sticky top-0 z-40 border-b border-[var(--docs-border)] bg-[var(--docs-bg)]/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
          {/* Zone 1: Brand Lockup */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              className="rounded-lg p-1.5 text-[var(--docs-text-secondary)] hover:bg-[var(--docs-surface)] lg:hidden"
              aria-label="Toggle navigation menu"
            >
              {mobileMenuOpen ? (
                <X className="h-5 w-5" />
              ) : (
                <Menu className="h-5 w-5" />
              )}
            </button>
            <Link
              to="/"
              className="flex items-center gap-2.5 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--docs-accent)]"
            >
              <ScaceBrandMark />
              <span className="font-display text-[17px] font-bold tracking-tight text-[var(--docs-text)]">
                Scace
              </span>
              <span className="text-xs font-medium text-[var(--docs-text-muted)]">
                Developers
              </span>
            </Link>
          </div>

          {/* Zone 2: Centered Search Bar */}
          <div className="flex flex-1 justify-center">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="flex w-full max-w-sm items-center justify-between gap-3 rounded-lg border border-[var(--docs-border)] bg-[var(--docs-surface)] px-3.5 py-2 text-xs text-[var(--docs-text-muted)] transition-colors hover:border-slate-300 dark:hover:border-slate-700"
            >
              <span className="flex items-center gap-2 truncate">
                <Search className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">Search docs</span>
              </span>
              <kbd className="hidden font-mono text-[11px] text-[var(--docs-text-muted)] sm:inline whitespace-nowrap">
                Ctrl K
              </kbd>
            </button>
          </div>

          {/* Zone 3: Theme + Sign In + Primary CTA */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={toggleTheme}
              className="rounded-lg p-2 text-[var(--docs-text-secondary)] transition-colors hover:bg-[var(--docs-surface)] hover:text-[var(--docs-text)]"
              aria-label={
                theme === "light" ? "Switch to dark mode" : "Switch to light mode"
              }
              title={
                theme === "light" ? "Switch to dark mode" : "Switch to light mode"
              }
            >
              {theme === "light" ? (
                <Moon className="h-4 w-4" />
              ) : (
                <Sun className="h-4 w-4" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setCredentialsOpen(true)}
              className="hidden sm:inline-flex items-center rounded-lg px-3 py-2 text-xs font-semibold text-[var(--docs-text)] transition-colors hover:bg-[var(--docs-surface)] whitespace-nowrap shrink-0"
            >
              {credentials.authMode === "bearer" && credentials.token
                ? "Auth Active"
                : "Sign In"}
            </button>

            <Link
              to="/docs/$slug"
              params={{ slug: "quickstart" }}
              className="inline-flex items-center rounded-lg bg-[var(--docs-accent)] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[var(--docs-accent-hover)] whitespace-nowrap shrink-0"
            >
              Get Started
            </Link>
          </div>
        </div>
      </header>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 top-16 z-30 flex lg:hidden">
          <div className="docs-scroll h-full w-72 overflow-y-auto border-r border-[var(--docs-border)] bg-[var(--docs-bg)]">
            {sidebarContent}
          </div>
          <div
            className="flex-1 bg-slate-950/30"
            onClick={() => setMobileMenuOpen(false)}
          />
        </div>
      )}

      {/* Three-Column Desktop Layout */}
      <div className="mx-auto flex max-w-[1440px]">
        <aside className="docs-scroll sticky top-16 hidden h-[calc(100vh-4rem)] w-[264px] shrink-0 overflow-y-auto border-r border-[var(--docs-border)] lg:block">
          {sidebarContent}
        </aside>

        <main className="min-w-0 flex-1 px-5 py-8 sm:px-8 lg:px-12 lg:py-10">
          {children}
        </main>

        <aside className="docs-scroll sticky top-16 hidden h-[calc(100vh-4rem)] w-60 shrink-0 overflow-y-auto border-l border-[var(--docs-border)] px-5 py-8 xl:block">
          {tocItems.length > 0 && (
            <div>
              <div className="mb-3 text-xs font-semibold text-[var(--docs-text)]">
                {tocTitle}
              </div>
              <ul className="space-y-2 border-l border-[var(--docs-border)] pl-3 text-xs">
                {tocItems.map((item) => (
                  <li key={item.id}>
                    <a
                      href={`#${item.id}`}
                      className="flex items-baseline gap-1.5 leading-5 text-[var(--docs-text-muted)] transition-colors hover:text-[var(--docs-accent)]"
                    >
                      {item.method && (
                        <span
                          className={`font-mono text-[10px] font-semibold shrink-0 ${methodAccentClasses(
                            item.method,
                          )}`}
                        >
                          {item.method}
                        </span>
                      )}
                      <span className="truncate">{item.label}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>

      <SearchModal />
      <CredentialsModal />
    </div>
  );
}
