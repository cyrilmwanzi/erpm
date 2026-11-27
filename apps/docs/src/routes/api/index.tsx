import { Link, createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { DocsShell, type TocItem } from "../../components/DocsShell.js";
import { SdkInitBanner } from "../../components/SdkInitBanner.js";
import { API_CATALOG, getCategorizedNamespaces } from "../../lib/catalog.js";
import { methodAccentClasses } from "../../lib/snippets.js";

export const Route = createFileRoute("/api/")({
  component: ApiDirectoryPage,
});

function ApiDirectoryPage() {
  const [filterQuery, setFilterQuery] = useState("");
  const categories = useMemo(() => getCategorizedNamespaces(), []);

  const filteredCategories = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return categories;
    return categories
      .map((cat) => ({
        ...cat,
        namespaces: cat.namespaces.filter(
          (ns) =>
            ns.title.toLowerCase().includes(q) ||
            ns.slug.toLowerCase().includes(q) ||
            ns.category.toLowerCase().includes(q) ||
            ns.endpoints.some(
              (ep) =>
                ep.path.toLowerCase().includes(q) ||
                ep.title.toLowerCase().includes(q),
            ),
        ),
      }))
      .filter((cat) => cat.namespaces.length > 0);
  }, [categories, filterQuery]);

  const tocItems: TocItem[] = [
    { id: "sdk-init", label: "SDK Initialization" },
    ...filteredCategories.map((cat) => ({
      id: `cat-${cat.category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      label: cat.category,
    })),
  ];

  return (
    <DocsShell tocItems={tocItems} tocTitle="API Categories">
      <div className="mx-auto max-w-[82ch]">
        <header className="border-b border-[var(--docs-border)] pb-8">
          <div className="text-xs font-medium text-[var(--docs-accent)]">
            REST API Reference
          </div>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-[var(--docs-text)] sm:text-[34px]">
            API Namespaces & Endpoints
          </h1>
          <p className="mt-3 text-[15.5px] leading-7 text-[var(--docs-text-secondary)]">
            Auto-generated directly from{" "}
            <span className="font-mono tabular-nums text-[var(--docs-text)]">
              {API_CATALOG.controllerCount}
            </span>{" "}
            NestJS controllers covering{" "}
            <span className="font-mono tabular-nums text-[var(--docs-text)]">
              {API_CATALOG.endpointCount}
            </span>{" "}
            HTTP endpoints across{" "}
            <span className="font-mono tabular-nums text-[var(--docs-text)]">
              {API_CATALOG.namespaces.length}
            </span>{" "}
            SDK namespaces. Select any namespace to inspect schemas, TypeScript SDK or cURL examples, and test live requests.
          </p>

          <div className="mt-6 max-w-md">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--docs-text-muted)]" />
              <input
                type="search"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="Filter namespaces or endpoint paths..."
                className="w-full rounded-lg border border-[var(--docs-border)] bg-[var(--docs-surface)] py-2 pl-9 pr-3 text-sm text-[var(--docs-text)] placeholder:text-[var(--docs-text-muted)] focus:border-[var(--docs-accent)] focus:outline-none"
              />
            </label>
          </div>
        </header>

        <SdkInitBanner defaultExpanded />

        <div className="mt-8 space-y-10">
          {filteredCategories.map((cat) => {
            const sectionId = `cat-${cat.category
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")}`;
            return (
              <section key={cat.category} id={sectionId} className="scroll-mt-24">
                <h2 className="font-display text-xl font-bold tracking-tight text-[var(--docs-text)]">
                  {cat.category}
                </h2>
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {cat.namespaces.map((ns) => {
                    const methods = Array.from(
                      new Set(ns.endpoints.map((ep) => ep.httpMethod)),
                    );
                    return (
                      <Link
                        key={ns.slug}
                        to="/api/$namespace"
                        params={{ namespace: ns.slug }}
                        className="group rounded-xl border border-[var(--docs-border)] p-4 transition-colors hover:border-[var(--docs-accent)]"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <h3 className="font-display text-base font-semibold text-[var(--docs-text)] group-hover:text-[var(--docs-accent)]">
                            {ns.title}
                          </h3>
                          <span className="font-mono text-xs tabular-nums text-[var(--docs-text-muted)]">
                            {ns.endpointCount}
                          </span>
                        </div>
                        <div className="mt-1 font-mono text-xs text-[var(--docs-text-muted)]">
                          scace.{ns.namespace}
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] font-semibold">
                          {methods.map((method) => (
                            <span
                              key={method}
                              className={methodAccentClasses(method)}
                            >
                              {method}
                            </span>
                          ))}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </section>
            );
          })}

          {filteredCategories.length === 0 && (
            <p className="py-12 text-sm text-[var(--docs-text-muted)]">
              No API namespaces matched &ldquo;{filterQuery}&rdquo;.
            </p>
          )}
        </div>
      </div>
    </DocsShell>
  );
}
