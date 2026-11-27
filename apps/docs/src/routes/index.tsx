import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowRight, BookOpen, Code2, CreditCard, ShieldCheck, Terminal } from "lucide-react";
import { CodeBlock } from "../components/CodeBlock.js";
import { DocsShell, type TocItem } from "../components/DocsShell.js";
import { API_CATALOG, getCategorizedNamespaces } from "../lib/catalog.js";

export const Route = createFileRoute("/")({
  component: DocsHomePage,
});

const HOME_TOC: TocItem[] = [
  { id: "overview", label: "Platform Overview" },
  { id: "quickstart-snippet", label: "Quickstart Example" },
  { id: "core-guides", label: "Core Documentation" },
  { id: "api-domains", label: "API Domains" },
];

const QUICKSTART_SDK_SNIPPET = `import { createScaceClient } from "@scace/sdk";

export const sdk = createScaceClient({
  baseUrl: "http://127.0.0.1:3001",
  auth: { type: "pat", token: process.env.SCACE_PAT! },
  organizationId: "org_01J9XYZ",
});

const expirySummary = await sdk.expiry.getSummary({});
const agingReport = await sdk.reports.getInventoryExpiryReport({});`;

function DocsHomePage() {
  const categories = getCategorizedNamespaces();

  return (
    <DocsShell tocItems={HOME_TOC} tocTitle="On this page">
      <div className="mx-auto max-w-[78ch]">
        <section id="overview" className="scroll-mt-24">
          <div className="text-xs font-medium text-[var(--docs-accent)]">
            Scace Developer Platform
          </div>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-[var(--docs-text)] sm:text-4xl">
            System Documentation & API Reference
          </h1>
          <p className="mt-4 text-[15.5px] leading-7 text-[var(--docs-text-secondary)]">
            Integrate multi-organization commerce, automated FEFO stock expiry control, multi-domain operational reporting, communication outbox webhooks, system billing governance, and M-Pesa Daraja payment flows using typed HTTP endpoints or the{" "}
            <code className="font-mono text-sm text-[var(--docs-text)]">@scace/sdk</code>{" "}
            client.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              to="/docs/$slug"
              params={{ slug: "quickstart" }}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--docs-accent)] px-4 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-[var(--docs-accent-hover)]"
            >
              Read Quickstart
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            <Link
              to="/api"
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--docs-border)] bg-[var(--docs-surface)] px-4 py-2.5 text-xs font-semibold text-[var(--docs-text)] transition-colors hover:border-[var(--docs-accent)]"
            >
              <Terminal className="h-3.5 w-3.5 text-[var(--docs-accent)]" />
              Explore{" "}
              <span className="tabular-nums">{API_CATALOG.endpointCount}</span>{" "}
              Endpoints
            </Link>
          </div>

          <dl className="mt-8 grid grid-cols-1 gap-4 border-y border-[var(--docs-border)] py-5 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-[var(--docs-text-muted)]">
                NestJS Controllers Indexed
              </dt>
              <dd className="mt-1 font-display text-2xl font-bold tabular-nums text-[var(--docs-text)]">
                {API_CATALOG.controllerCount}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--docs-text-muted)]">
                API Reference Endpoints
              </dt>
              <dd className="mt-1 font-display text-2xl font-bold tabular-nums text-[var(--docs-text)]">
                {API_CATALOG.endpointCount}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--docs-text-muted)]">
                SDK Namespaces
              </dt>
              <dd className="mt-1 font-display text-2xl font-bold tabular-nums text-[var(--docs-text)]">
                {API_CATALOG.namespaces.length}
              </dd>
            </div>
          </dl>
        </section>

        <section id="quickstart-snippet" className="mt-12 scroll-mt-24">
          <h2 className="font-display text-2xl font-bold tracking-tight text-[var(--docs-text)]">
            Initialize @scace/sdk Once
          </h2>
          <p className="mt-3 text-[15px] leading-7 text-[var(--docs-text-secondary)]">
            Code examples across this portal default to{" "}
            <code className="font-mono text-xs text-[var(--docs-text)]">
              @scace/sdk
            </code>{" "}
            and assume one shared client instance configured with your{" "}
            <code className="font-mono text-xs text-[var(--docs-text)]">
              organizationId
            </code>
            , so individual endpoints focus purely on the method call.
          </p>
          <div className="mt-5">
            <CodeBlock
              language="typescript"
              label="TYPESCRIPT SDK"
              code={QUICKSTART_SDK_SNIPPET}
            />
          </div>
        </section>

        <section id="core-guides" className="mt-12 scroll-mt-24">
          <h2 className="font-display text-2xl font-bold tracking-tight text-[var(--docs-text)]">
            Core System Guides
          </h2>
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Link
              to="/docs/$slug"
              params={{ slug: "webhooks" }}
              className="group rounded-xl border border-[var(--docs-border)] p-5 transition-colors hover:border-[var(--docs-accent)]"
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--docs-accent)]">
                <Code2 className="h-4 w-4" />
                API Fundamentals
              </div>
              <h3 className="mt-2 font-display text-base font-semibold text-[var(--docs-text)] group-hover:text-[var(--docs-accent)]">
                Webhooks & Communication Outbox
              </h3>
              <p className="mt-1.5 text-sm leading-6 text-[var(--docs-text-secondary)]">
                Configure dispatch rules, HMAC webhook headers, and scheduled event delivery for expiry alerts and reports.
              </p>
            </Link>

            <Link
              to="/docs/$slug"
              params={{ slug: "inventory-expiry" }}
              className="group rounded-xl border border-[var(--docs-border)] p-5 transition-colors hover:border-[var(--docs-accent)]"
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--docs-accent)]">
                <BookOpen className="h-4 w-4" />
                Use Cases
              </div>
              <h3 className="mt-2 font-display text-base font-semibold text-[var(--docs-text)] group-hover:text-[var(--docs-accent)]">
                Stock Expiry & FEFO Allocation
              </h3>
              <p className="mt-1.5 text-sm leading-6 text-[var(--docs-text-secondary)]">
                Understand automated First-Expired-First-Out reservation, lot quarantine scans, and manual batch overrides.
              </p>
            </Link>

            <Link
              to="/docs/$slug"
              params={{ slug: "billing-governance" }}
              className="group rounded-xl border border-[var(--docs-border)] p-5 transition-colors hover:border-[var(--docs-accent)]"
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--docs-accent)]">
                <CreditCard className="h-4 w-4" />
                Billing & M-Pesa
              </div>
              <h3 className="mt-2 font-display text-base font-semibold text-[var(--docs-text)] group-hover:text-[var(--docs-accent)]">
                Organization Billing & Free Trials
              </h3>
              <p className="mt-1.5 text-sm leading-6 text-[var(--docs-text-secondary)]">
                Learn how auto-provisioned trials, M-Pesa subscription checkout, grace periods, and admin overrides work.
              </p>
            </Link>

            <Link
              to="/docs/$slug"
              params={{ slug: "organizations-rbac" }}
              className="group rounded-xl border border-[var(--docs-border)] p-5 transition-colors hover:border-[var(--docs-accent)]"
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--docs-accent)]">
                <ShieldCheck className="h-4 w-4" />
                Governance
              </div>
              <h3 className="mt-2 font-display text-base font-semibold text-[var(--docs-text)] group-hover:text-[var(--docs-accent)]">
                Organizations, RBAC & Isolation
              </h3>
              <p className="mt-1.5 text-sm leading-6 text-[var(--docs-text-secondary)]">
                Organization resolution, Postgres RLS enforcement, PATs, and granular resource permissions.
              </p>
            </Link>
          </div>
        </section>

        <section id="api-domains" className="mt-12 scroll-mt-24">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-display text-2xl font-bold tracking-tight text-[var(--docs-text)]">
              API Reference Domains
            </h2>
            <Link
              to="/api"
              className="text-xs font-semibold text-[var(--docs-accent)] hover:underline"
            >
              View all namespaces
            </Link>
          </div>
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {categories.map((cat) => {
              const total = cat.namespaces.reduce(
                (acc, ns) => acc + ns.endpointCount,
                0,
              );
              return (
                <div
                  key={cat.category}
                  className="rounded-xl border border-[var(--docs-border)] p-5"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="font-display text-base font-semibold text-[var(--docs-text)]">
                      {cat.category}
                    </h3>
                    <span className="font-mono text-xs tabular-nums text-[var(--docs-text-muted)]">
                      {total} endpoints
                    </span>
                  </div>
                  <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
                    {cat.namespaces.map((ns) => (
                      <li key={ns.slug}>
                        <Link
                          to="/api/$namespace"
                          params={{ namespace: ns.slug }}
                          className="text-[var(--docs-text-secondary)] underline decoration-[var(--docs-border)] underline-offset-4 transition-colors hover:text-[var(--docs-accent)] hover:decoration-[var(--docs-accent)]"
                        >
                          {ns.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </DocsShell>
  );
}
