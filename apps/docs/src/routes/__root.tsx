import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { DocsShell } from "../components/DocsShell.js";
import { DocsAppProvider } from "../components/ThemeContext.js";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Scace Developers — Documentation & API Reference" },
      {
        name: "description",
        content:
          "System architecture guides, M-Pesa Daraja payment flows, FEFO expiry tracking, billing governance, and interactive API reference for the Scace platform.",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400..700;1,9..40,400..700&family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@500;600;700&display=swap",
      },
    ],
  }),
  component: RootDocument,
  notFoundComponent: DocsNotFound,
});

function RootDocument() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <DocsAppProvider>
          <Outlet />
        </DocsAppProvider>
        <Scripts />
      </body>
    </html>
  );
}

function DocsNotFound() {
  return (
    <DocsShell>
      <div className="mx-auto max-w-[68ch] py-12">
        <p className="text-xs font-medium text-[var(--docs-accent)]">404</p>
        <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-[var(--docs-text)]">
          Documentation page not found
        </h1>
        <p className="mt-3 text-sm leading-6 text-[var(--docs-text-secondary)]">
          The guide or API namespace you requested does not exist. Use the sidebar or press Ctrl K to search all documentation and endpoints.
        </p>
        <div className="mt-6 flex items-center gap-3">
          <Link
            to="/"
            className="rounded-lg bg-[var(--docs-accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--docs-accent-hover)]"
          >
            Back to Overview
          </Link>
          <Link
            to="/api"
            className="rounded-lg border border-[var(--docs-border)] px-4 py-2 text-xs font-semibold text-[var(--docs-text)] hover:bg-[var(--docs-surface)]"
          >
            Browse API Reference
          </Link>
        </div>
      </div>
    </DocsShell>
  );
}
