import { Play, RotateCcw, Send, Terminal } from "lucide-react";
import { useMemo, useState } from "react";
import type { ApiEndpointDoc } from "../generated/api-types.js";
import {
  authModeLabel,
  buildCurlSnippet,
  buildSdkSnippet,
  methodAccentClasses,
  resolveEndpointUrl,
} from "../lib/snippets.js";
import { CodeBlock } from "./CodeBlock.js";
import { SchemaExplorer } from "./SchemaExplorer.js";
import { useDocsApp } from "./ThemeContext.js";

interface TryItResponseState {
  status: number;
  statusText: string;
  durationMs: number;
  requestId: string | null;
  billingStatus: string | null;
  contentType: string;
  bodyText: string;
  isJson: boolean;
}

export function EndpointCard({ endpoint }: { endpoint: ApiEndpointDoc }) {
  const { credentials, setCredentialsOpen } = useDocsApp();

  const [snippetTab, setSnippetTab] = useState<"sdk" | "curl">("sdk");
  const [includeInit, setIncludeInit] = useState(false);
  const [schemaTab, setSchemaTab] = useState<
    "params" | "body" | "response"
  >(() =>
    endpoint.bodyFields.length > 0 || endpoint.bodyType
      ? "body"
      : endpoint.pathParams.length > 0 || endpoint.queryFields.length > 0
        ? "params"
        : "response",
  );
  const [tryItOpen, setTryItOpen] = useState(false);

  const [pathValues, setPathValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(endpoint.pathParams.map((p) => [p.key, ""])),
  );
  const [queryValues, setQueryValues] = useState<Record<string, string>>({});
  const defaultBodyString = useMemo(
    () =>
      endpoint.sampleBody !== undefined
        ? JSON.stringify(endpoint.sampleBody, null, 2)
        : "",
    [endpoint.sampleBody],
  );
  const [bodyDraft, setBodyDraft] = useState(defaultBodyString);
  const [orgOverride, setOrgOverride] = useState("");
  const [loading, setLoading] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [responseState, setResponseState] = useState<TryItResponseState | null>(
    null,
  );

  const effectiveOrgId =
    orgOverride.trim() || credentials.organizationId.trim();

  const sdkSnippet = useMemo(
    () =>
      buildSdkSnippet(endpoint, {
        pathValues,
        queryValues,
        bodyJson: bodyDraft,
        organizationId: effectiveOrgId,
        includeInit,
      }),
    [endpoint, pathValues, queryValues, bodyDraft, effectiveOrgId, includeInit],
  );

  const curlSnippet = useMemo(
    () =>
      buildCurlSnippet(endpoint, {
        pathValues,
        queryValues,
        bodyJson: bodyDraft,
        organizationId: effectiveOrgId,
      }),
    [endpoint, pathValues, queryValues, bodyDraft, effectiveOrgId],
  );

  const permissionSummary = useMemo(() => {
    if (!endpoint.permissions) return null;
    return Object.entries(endpoint.permissions)
      .flatMap(([res, acts]) => acts.map((a) => `${res}:${a}`))
      .join(", ");
  }, [endpoint.permissions]);

  const handleSendTryIt = async (event: React.FormEvent) => {
    event.preventDefault();
    setClientError(null);

    for (const p of endpoint.pathParams) {
      if (!pathValues[p.key]?.trim()) {
        setClientError(`Path parameter "${p.key}" is required.`);
        return;
      }
    }

    const relativeUrl = resolveEndpointUrl(endpoint, pathValues, queryValues);
    // Strict same-origin API prefix guard
    if (
      !relativeUrl.startsWith("/api/") &&
      !relativeUrl.startsWith("/.well-known/") &&
      relativeUrl !== "/"
    ) {
      setClientError("Blocked non-API target path.");
      return;
    }

    let requestBody: string | undefined;
    if (
      endpoint.httpMethod !== "GET" &&
      endpoint.bodyType &&
      !endpoint.isMultipart &&
      bodyDraft.trim().length > 0
    ) {
      try {
        JSON.parse(bodyDraft);
        requestBody = bodyDraft;
      } catch {
        setClientError("Request body must be valid JSON.");
        return;
      }
    }

    const headers: Record<string, string> = {};
    if (requestBody !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (credentials.authMode === "bearer" && credentials.token.trim()) {
      headers.Authorization = `Bearer ${credentials.token.trim()}`;
    }
    if (effectiveOrgId) {
      headers["X-Organization-Id"] = effectiveOrgId;
    }

    setLoading(true);
    const started = performance.now();
    try {
      const res = await fetch(relativeUrl, {
        method: endpoint.httpMethod,
        headers,
        credentials: "include",
        ...(requestBody !== undefined ? { body: requestBody } : {}),
      });
      const durationMs = Math.round(performance.now() - started);
      const contentType = res.headers.get("content-type") ?? "text/plain";
      const rawText = await res.text();
      let formattedText = rawText;
      let isJson = false;

      if (contentType.includes("application/json") || rawText.startsWith("{") || rawText.startsWith("[")) {
        try {
          formattedText = JSON.stringify(JSON.parse(rawText), null, 2);
          isJson = true;
        } catch {
          isJson = false;
        }
      }

      setResponseState({
        status: res.status,
        statusText: res.statusText,
        durationMs,
        requestId: res.headers.get("x-request-id"),
        billingStatus: res.headers.get("x-scace-billing-status"),
        contentType,
        bodyText: formattedText || "(empty response body)",
        isJson,
      });
    } catch (err) {
      setClientError(
        err instanceof Error ? err.message : "Network request failed.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      id={endpoint.id}
      className="scroll-mt-24 border-b border-[var(--docs-border)] pb-12 pt-8 first:pt-0 last:border-b-0"
    >
      {/* Endpoint Title & Signature */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-xl font-semibold tracking-tight text-[var(--docs-text)]">
            {endpoint.title}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-[var(--docs-text-muted)]">
            <span
              className={`font-semibold ${methodAccentClasses(
                endpoint.httpMethod,
              )}`}
            >
              {endpoint.httpMethod}
            </span>
            <span className="break-all font-medium text-[var(--docs-text)]">
              {endpoint.path}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[var(--docs-text-muted)]">
            <span>{authModeLabel(endpoint.authMode)}</span>
            {permissionSummary && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{permissionSummary}</span>
              </>
            )}
            {endpoint.billingExempt && (
              <>
                <span aria-hidden="true">·</span>
                <span>Billing lock exempt</span>
              </>
            )}
            {endpoint.billingFeature && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono">Feature: {endpoint.billingFeature}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span className="font-mono">
              sdk.{endpoint.namespace}.{endpoint.methodName}()
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setTryItOpen((prev) => !prev)}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
            tryItOpen
              ? "border border-[var(--docs-border)] bg-[var(--docs-surface)] text-[var(--docs-text)]"
              : "bg-[var(--docs-accent)] text-white hover:bg-[var(--docs-accent-hover)]"
          }`}
        >
          <Play className="h-3.5 w-3.5" />
          {tryItOpen ? "Hide Try-It" : "Try It"}
        </button>
      </div>

      {/* Schema Explorer & Code Examples Split */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <div className="mb-3 flex items-center gap-1 rounded-lg border border-[var(--docs-border)] bg-[var(--docs-surface)] p-1 w-fit">
            <button
              type="button"
              onClick={() => setSchemaTab("params")}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                schemaTab === "params"
                  ? "bg-[var(--docs-bg)] text-[var(--docs-text)] shadow-xs"
                  : "text-[var(--docs-text-muted)] hover:text-[var(--docs-text)]"
              }`}
            >
              Params ({endpoint.pathParams.length + endpoint.queryFields.length})
            </button>
            <button
              type="button"
              onClick={() => setSchemaTab("body")}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                schemaTab === "body"
                  ? "bg-[var(--docs-bg)] text-[var(--docs-text)] shadow-xs"
                  : "text-[var(--docs-text-muted)] hover:text-[var(--docs-text)]"
              }`}
            >
              Body ({endpoint.bodyFields.length})
            </button>
            <button
              type="button"
              onClick={() => setSchemaTab("response")}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                schemaTab === "response"
                  ? "bg-[var(--docs-bg)] text-[var(--docs-text)] shadow-xs"
                  : "text-[var(--docs-text-muted)] hover:text-[var(--docs-text)]"
              }`}
            >
              Response
            </button>
          </div>

          {schemaTab === "params" && (
            <div className="space-y-4">
              {endpoint.pathParams.length > 0 && (
                <div>
                  <div className="mb-2 text-xs font-semibold text-[var(--docs-text)]">
                    Path Parameters
                  </div>
                  <SchemaExplorer
                    fields={endpoint.pathParams.map((p) => ({
                      name: p.key,
                      type: p.type,
                      required: true,
                    }))}
                    emptyLabel="No path parameters."
                  />
                </div>
              )}
              <div>
                <div className="mb-2 text-xs font-semibold text-[var(--docs-text)]">
                  Query Parameters
                </div>
                <SchemaExplorer
                  fields={endpoint.queryFields}
                  rawType={endpoint.queryType}
                  emptyLabel="This endpoint accepts no query parameters."
                />
              </div>
            </div>
          )}

          {schemaTab === "body" && (
            <SchemaExplorer
              fields={endpoint.bodyFields}
              rawType={endpoint.bodyType}
              emptyLabel="This endpoint does not take a request body."
            />
          )}

          {schemaTab === "response" && (
            <SchemaExplorer
              fields={endpoint.responseFields}
              rawType={endpoint.responseType}
              emptyLabel={`Returns ${endpoint.responseType}`}
            />
          )}
        </div>

        <div className="lg:col-span-6">
          <CodeBlock
            language={snippetTab === "sdk" ? "typescript" : "curl"}
            label={snippetTab === "sdk" ? "TYPESCRIPT SDK" : "cURL"}
            code={snippetTab === "sdk" ? sdkSnippet : curlSnippet}
            headerRight={
              <div className="flex items-center gap-2">
                {snippetTab === "sdk" && (
                  <button
                    type="button"
                    onClick={() => setIncludeInit((prev) => !prev)}
                    title="Toggle createScaceClient initialization snippet"
                    className={`rounded border px-2 py-0.5 text-[11px] font-medium transition-colors whitespace-nowrap ${
                      includeInit
                        ? "border-blue-400/50 bg-blue-500/20 text-blue-200"
                        : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200"
                    }`}
                  >
                    {includeInit ? "With init" : "+ Init"}
                  </button>
                )}
                <div className="inline-flex items-center gap-1 rounded bg-slate-800/80 p-0.5">
                  <button
                    type="button"
                    onClick={() => setSnippetTab("sdk")}
                    className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors whitespace-nowrap ${
                      snippetTab === "sdk"
                        ? "bg-slate-700 text-white"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    SDK
                  </button>
                  <button
                    type="button"
                    onClick={() => setSnippetTab("curl")}
                    className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors whitespace-nowrap ${
                      snippetTab === "curl"
                        ? "bg-slate-700 text-white"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    cURL
                  </button>
                </div>
              </div>
            }
          />
        </div>
      </div>

      {/* Interactive Try-It Console */}
      {tryItOpen && (
        <div className="mt-6 rounded-xl border border-[var(--docs-border)] bg-[var(--docs-surface)] p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--docs-border)] pb-3">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-[var(--docs-accent)]" />
              <span className="text-sm font-semibold text-[var(--docs-text)]">
                Interactive Request Runner
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs text-[var(--docs-text-muted)]">
              <span>
                Auth:{" "}
                <strong className="font-medium text-[var(--docs-text)]">
                  {credentials.authMode === "bearer" && credentials.token
                    ? "Bearer / PAT"
                    : "Cookie Session"}
                </strong>
              </span>
              <button
                type="button"
                onClick={() => setCredentialsOpen(true)}
                className="font-medium text-[var(--docs-accent)] hover:underline"
              >
                Configure credentials
              </button>
            </div>
          </div>

          <form onSubmit={handleSendTryIt} className="mt-4 space-y-4">
            {endpoint.pathParams.length > 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {endpoint.pathParams.map((p) => (
                  <div key={p.key}>
                    <label className="mb-1 block font-mono text-xs font-medium text-[var(--docs-text)]">
                      :{p.key} *
                    </label>
                    <input
                      type="text"
                      value={pathValues[p.key] ?? ""}
                      onChange={(e) =>
                        setPathValues((prev) => ({
                          ...prev,
                          [p.key]: e.target.value,
                        }))
                      }
                      placeholder={`Enter ${p.key}`}
                      className="w-full rounded-lg border border-[var(--docs-border)] bg-[var(--docs-bg)] px-3 py-1.5 font-mono text-xs text-[var(--docs-text)] focus:border-[var(--docs-accent)] focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            )}

            {endpoint.queryFields.length > 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {endpoint.queryFields.slice(0, 6).map((q) => (
                  <div key={q.name}>
                    <label className="mb-1 block font-mono text-xs text-[var(--docs-text-secondary)]">
                      ?{q.name}
                      {q.required ? " *" : ""}
                    </label>
                    <input
                      type="text"
                      value={queryValues[q.name] ?? ""}
                      onChange={(e) =>
                        setQueryValues((prev) => ({
                          ...prev,
                          [q.name]: e.target.value,
                        }))
                      }
                      placeholder={q.type}
                      className="w-full rounded-lg border border-[var(--docs-border)] bg-[var(--docs-bg)] px-3 py-1.5 font-mono text-xs text-[var(--docs-text)] focus:border-[var(--docs-accent)] focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            )}

            {endpoint.authMode === "organization" && (
              <div className="max-w-sm">
                <label className="mb-1 block font-mono text-xs text-[var(--docs-text-secondary)]">
                  X-Organization-Id (override)
                </label>
                <input
                  type="text"
                  value={orgOverride}
                  onChange={(e) => setOrgOverride(e.target.value)}
                  placeholder={credentials.organizationId || "org_01J9XYZ"}
                  className="w-full rounded-lg border border-[var(--docs-border)] bg-[var(--docs-bg)] px-3 py-1.5 font-mono text-xs text-[var(--docs-text)] focus:border-[var(--docs-accent)] focus:outline-none"
                />
              </div>
            )}

            {endpoint.bodyType && !endpoint.isMultipart && (
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="font-mono text-xs font-medium text-[var(--docs-text)]">
                    Request JSON Body
                  </label>
                  <button
                    type="button"
                    onClick={() => setBodyDraft(defaultBodyString)}
                    className="inline-flex items-center gap-1 text-xs text-[var(--docs-text-muted)] hover:text-[var(--docs-text)]"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Reset sample
                  </button>
                </div>
                <textarea
                  rows={6}
                  value={bodyDraft}
                  onChange={(e) => setBodyDraft(e.target.value)}
                  spellCheck={false}
                  className="docs-scroll w-full rounded-lg border border-[var(--docs-border)] bg-[var(--docs-bg)] p-3 font-mono text-xs leading-5 text-[var(--docs-text)] focus:border-[var(--docs-accent)] focus:outline-none"
                />
              </div>
            )}

            {endpoint.isMultipart && (
              <p className="text-xs text-[var(--docs-text-muted)]">
                Multipart binary upload endpoint: copy the cURL or TypeScript SDK snippet above to upload files directly.
              </p>
            )}

            {clientError && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
                {clientError}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="font-mono text-xs text-[var(--docs-text-muted)]">
                Target: {resolveEndpointUrl(endpoint, pathValues, queryValues)}
              </div>
              <button
                type="submit"
                disabled={loading || endpoint.isMultipart}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--docs-accent)] px-4 py-2 text-xs font-medium text-white hover:bg-[var(--docs-accent-hover)] disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
                {loading ? "Sending..." : "Send Request"}
              </button>
            </div>
          </form>

          {responseState && (
            <div className="mt-5 space-y-2 border-t border-[var(--docs-border)] pt-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
                <span
                  className={
                    responseState.status >= 200 && responseState.status < 300
                      ? "font-semibold text-emerald-700 dark:text-emerald-400"
                      : "font-semibold text-rose-700 dark:text-rose-400"
                  }
                >
                  HTTP {responseState.status} {responseState.statusText}
                </span>
                <span className="text-[var(--docs-text-muted)]">·</span>
                <span className="tabular-nums text-[var(--docs-text-secondary)]">
                  {responseState.durationMs} ms
                </span>
                {responseState.requestId && (
                  <>
                    <span className="text-[var(--docs-text-muted)]">·</span>
                    <span className="text-[var(--docs-text-muted)]">
                      X-Request-Id: {responseState.requestId}
                    </span>
                  </>
                )}
                {responseState.billingStatus && (
                  <>
                    <span className="text-[var(--docs-text-muted)]">·</span>
                    <span className="text-[var(--docs-text-muted)]">
                      Billing: {responseState.billingStatus}
                    </span>
                  </>
                )}
              </div>
              <CodeBlock
                language={responseState.isJson ? "json" : "text"}
                label={responseState.isJson ? "RESPONSE JSON" : "RESPONSE"}
                code={responseState.bodyText}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
