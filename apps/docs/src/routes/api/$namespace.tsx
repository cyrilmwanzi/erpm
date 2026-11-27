import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { DocsShell, type TocItem } from "../../components/DocsShell.js";
import { EndpointCard } from "../../components/EndpointCard.js";
import { SdkInitBanner } from "../../components/SdkInitBanner.js";
import type { ApiEndpointDoc } from "../../generated/api-types.js";
import { getNamespaceBySlug } from "../../lib/catalog.js";

export const Route = createFileRoute("/api/$namespace")({
  component: ApiNamespacePage,
});

type MethodFilter = "ALL" | ApiEndpointDoc["httpMethod"];

function ApiNamespacePage() {
  const { namespace } = Route.useParams();
  const group = getNamespaceBySlug(namespace);
  const [methodFilter, setMethodFilter] = useState<MethodFilter>("ALL");

  const availableMethods = useMemo(() => {
    if (!group) return [];
    const set = new Set(group.endpoints.map((ep) => ep.httpMethod));
    return Array.from(set);
  }, [group]);

  const filteredEndpoints = useMemo(() => {
    if (!group) return [];
    if (methodFilter === "ALL") return group.endpoints;
    return group.endpoints.filter((ep) => ep.httpMethod === methodFilter);
  }, [group, methodFilter]);

  const controllerNames = useMemo(() => {
    if (!group) return [];
    return Array.from(new Set(group.endpoints.map((ep) => ep.controller)));
  }, [group]);

  if (!group) {
    return (
      <DocsShell>
        <div className="mx-auto max-w-[70ch] py-12">
          <div className="text-xs font-medium text-[var(--docs-accent)]">
            API Reference
          </div>
          <h1 className="mt-2 font-display text-3xl font-bold text-[var(--docs-text)]">
            Namespace &ldquo;{namespace}&rdquo; not found
          </h1>
          <p className="mt-3 text-sm text-[var(--docs-text-secondary)]">
            Select a namespace from the left navigation or browse the full API directory.
          </p>
          <Link
            to="/api"
            className="mt-6 inline-flex rounded-lg bg-[var(--docs-accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--docs-accent-hover)]"
          >
            Browse API Directory
          </Link>
        </div>
      </DocsShell>
    );
  }

  const tocItems: TocItem[] = [
    { id: "sdk-init", label: "SDK Initialization" },
    ...filteredEndpoints.map((ep) => ({
      id: ep.id,
      label: ep.title,
      method: ep.httpMethod,
    })),
  ];

  return (
    <DocsShell tocItems={tocItems} tocTitle="Endpoints">
      <div className="mx-auto max-w-[92ch]">
        <header className="border-b border-[var(--docs-border)] pb-8">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--docs-text-muted)]">
            <Link
              to="/api"
              className="font-medium text-[var(--docs-accent)] hover:underline"
            >
              API Reference
            </Link>
            <span aria-hidden="true">/</span>
            <span>{group.category}</span>
          </div>

          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-[var(--docs-text)] sm:text-[34px]">
            {group.title}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--docs-text-muted)]">
            <span className="font-mono text-[var(--docs-text-secondary)]">
              sdk.{group.namespace}
            </span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">
              {group.endpointCount} endpoints
            </span>
            {controllerNames.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{controllerNames.join(", ")}</span>
              </>
            )}
          </div>

          {availableMethods.length > 1 && (
            <div className="mt-5 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setMethodFilter("ALL")}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  methodFilter === "ALL"
                    ? "bg-[var(--docs-accent)] text-white"
                    : "border border-[var(--docs-border)] text-[var(--docs-text-secondary)] hover:text-[var(--docs-text)]"
                }`}
              >
                All (<span className="tabular-nums">{group.endpoints.length}</span>)
              </button>
              {availableMethods.map((method) => {
                const count = group.endpoints.filter(
                  (ep) => ep.httpMethod === method,
                ).length;
                return (
                  <button
                    key={method}
                    type="button"
                    onClick={() => setMethodFilter(method)}
                    className={`rounded-md px-2.5 py-1 font-mono text-xs font-medium transition-colors ${
                      methodFilter === method
                        ? "bg-[var(--docs-accent)] text-white"
                        : "border border-[var(--docs-border)] text-[var(--docs-text-secondary)] hover:text-[var(--docs-text)]"
                    }`}
                  >
                    {method} (<span className="tabular-nums">{count}</span>)
                  </button>
                );
              })}
            </div>
          )}
        </header>

        <SdkInitBanner />

        <div className="mt-6">
          {filteredEndpoints.map((endpoint) => (
            <EndpointCard key={endpoint.id} endpoint={endpoint} />
          ))}
        </div>
      </div>
    </DocsShell>
  );
}
