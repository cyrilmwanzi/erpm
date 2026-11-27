import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Package } from "lucide-react";
import { useState } from "react";
import { buildSdkInitializationSnippet } from "../lib/snippets.js";
import { CodeBlock } from "./CodeBlock.js";
import { useDocsApp } from "./ThemeContext.js";

interface SdkInitBannerProps {
  defaultExpanded?: boolean;
}

export function SdkInitBanner({ defaultExpanded = false }: SdkInitBannerProps) {
  const { credentials } = useDocsApp();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [authTab, setAuthTab] = useState<"pat" | "oauth2">("pat");

  const initCode = buildSdkInitializationSnippet({
    organizationId: credentials.organizationId,
    authMode: authTab,
  });

  return (
    <section
      id="sdk-init"
      className="mt-6 rounded-xl border border-[var(--docs-border)] bg-[var(--docs-surface)] px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Package className="mt-0.5 h-4 w-4 shrink-0 text-[var(--docs-accent)]" />
          <div>
            <div className="text-xs font-semibold text-[var(--docs-text)]">
              SDK Initialization (
              <code className="font-mono text-[11px]">@scace/sdk</code>)
            </div>
            <p className="mt-0.5 text-xs text-[var(--docs-text-secondary)]">
              Endpoint examples default to{" "}
              <code className="font-mono text-[var(--docs-text)]">sdk</code> and
              assume a single shared client instance.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <Link
            to="/docs/$slug"
            params={{ slug: "sdk-guide" }}
            className="text-xs font-medium text-[var(--docs-accent)] hover:underline whitespace-nowrap"
          >
            SDK Setup Guide
          </Link>
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--docs-border)] bg-[var(--docs-bg)] px-2.5 py-1 text-xs font-medium text-[var(--docs-text)] transition-colors hover:border-[var(--docs-accent)] whitespace-nowrap"
          >
            {expanded ? (
              <>
                <ChevronDown className="h-3.5 w-3.5" />
                Hide initialization
              </>
            ) : (
              <>
                <ChevronRight className="h-3.5 w-3.5" />
                Show initialization
              </>
            )}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3 border-t border-[var(--docs-border)] pt-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--docs-text-secondary)]">
            <span>
              Install{" "}
              <code className="rounded bg-[var(--docs-bg)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--docs-text)]">
                npm install @scace/sdk
              </code>{" "}
              and export one initialized client:
            </span>
            <div className="inline-flex items-center gap-1 rounded-md border border-[var(--docs-border)] bg-[var(--docs-bg)] p-0.5">
              <button
                type="button"
                onClick={() => setAuthTab("pat")}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  authTab === "pat"
                    ? "bg-[var(--docs-accent)] text-white"
                    : "text-[var(--docs-text-muted)] hover:text-[var(--docs-text)]"
                }`}
              >
                PAT
              </button>
              <button
                type="button"
                onClick={() => setAuthTab("oauth2")}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  authTab === "oauth2"
                    ? "bg-[var(--docs-accent)] text-white"
                    : "text-[var(--docs-text-muted)] hover:text-[var(--docs-text)]"
                }`}
              >
                OAuth2 M2M
              </button>
            </div>
          </div>

          <CodeBlock
            language="typescript"
            label="SDK CLIENT SETUP"
            code={initCode}
          />
        </div>
      )}
    </section>
  );
}
