import { KeyRound, LogIn, ShieldCheck, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useDocsApp } from "./ThemeContext.js";

export function CredentialsModal() {
  const {
    credentialsOpen,
    setCredentialsOpen,
    credentials,
    setCredentials,
    clearCredentials,
  } = useDocsApp();

  const [tab, setTab] = useState<"token" | "signin">("token");
  const [tokenInput, setTokenInput] = useState(credentials.token);
  const [orgInput, setOrgInput] = useState(credentials.organizationId);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!credentialsOpen) return null;

  const handleSaveToken = (event: React.FormEvent) => {
    event.preventDefault();
    setErrorMessage(null);
    setCredentials({
      authMode: tokenInput.trim() ? "bearer" : "session",
      token: tokenInput.trim(),
      organizationId: orgInput.trim(),
    });
    setStatusMessage("In-memory credentials updated for Try-It requests.");
  };

  const handleSignIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        message?: string;
        token?: string;
        user?: { email?: string };
      };
      if (!response.ok) {
        setErrorMessage(data.message || `Sign-in failed (${response.status}).`);
        return;
      }
      setCredentials({
        authMode: data.token ? "bearer" : "session",
        token: data.token ?? "",
        organizationId: orgInput.trim(),
      });
      setStatusMessage(
        `Signed in as ${data.user?.email ?? email.trim()}. Try-It requests will now include your active session.`,
      );
      setPassword("");
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Unable to reach the authentication endpoint.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label="Developer API Credentials"
      onClick={() => setCredentialsOpen(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-[var(--docs-border)] bg-[var(--docs-bg)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--docs-border)] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 text-[var(--docs-accent)]" />
            <h2 className="font-display text-base font-semibold text-[var(--docs-text)]">
              Try-It Credentials
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setCredentialsOpen(false)}
            className="rounded p-1 text-[var(--docs-text-muted)] hover:bg-[var(--docs-surface-hover)] hover:text-[var(--docs-text)]"
            aria-label="Close credentials dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-[var(--docs-border)] bg-[var(--docs-surface)] px-5 py-2.5">
          <div className="inline-flex items-center gap-1 rounded-lg bg-[var(--docs-bg)] p-1 border border-[var(--docs-border)]">
            <button
              type="button"
              onClick={() => setTab("token")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                tab === "token"
                  ? "bg-[var(--docs-accent)] text-white"
                  : "text-[var(--docs-text-secondary)] hover:text-[var(--docs-text)]"
              }`}
            >
              <KeyRound className="h-3.5 w-3.5" />
              PAT / Bearer Token
            </button>
            <button
              type="button"
              onClick={() => setTab("signin")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                tab === "signin"
                  ? "bg-[var(--docs-accent)] text-white"
                  : "text-[var(--docs-text-secondary)] hover:text-[var(--docs-text)]"
              }`}
            >
              <LogIn className="h-3.5 w-3.5" />
              Email Sign In
            </button>
          </div>
        </div>

        <div className="p-5">
          <p className="mb-4 text-xs leading-5 text-[var(--docs-text-muted)]">
            Tokens are held strictly in memory for the current browser tab and are never stored in localStorage.
          </p>

          {tab === "token" ? (
            <form onSubmit={handleSaveToken} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-[var(--docs-text)]">
                  Bearer Token or PAT (`scace_pat_...`)
                </label>
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="scace_pat_..."
                  autoComplete="off"
                  className="w-full rounded-lg border border-[var(--docs-border)] bg-[var(--docs-surface)] px-3 py-2 font-mono text-xs text-[var(--docs-text)] focus:border-[var(--docs-accent)] focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-[var(--docs-text)]">
                  Active Organization ID (`X-Organization-Id`)
                </label>
                <input
                  type="text"
                  value={orgInput}
                  onChange={(e) => setOrgInput(e.target.value)}
                  placeholder="org_01J9XYZ (optional)"
                  className="w-full rounded-lg border border-[var(--docs-border)] bg-[var(--docs-surface)] px-3 py-2 font-mono text-xs text-[var(--docs-text)] focus:border-[var(--docs-accent)] focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-between gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    clearCredentials();
                    setTokenInput("");
                    setOrgInput("");
                    setStatusMessage("Cleared in-memory credentials.");
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--docs-border)] px-3 py-2 text-xs font-medium text-[var(--docs-text-secondary)] hover:bg-[var(--docs-surface)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-[var(--docs-accent)] px-4 py-2 text-xs font-medium text-white hover:bg-[var(--docs-accent-hover)]"
                >
                  Apply to Try-It
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleSignIn} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-[var(--docs-text)]">
                  Account Email
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@acme.co.ke"
                  className="w-full rounded-lg border border-[var(--docs-border)] bg-[var(--docs-surface)] px-3 py-2 text-xs text-[var(--docs-text)] focus:border-[var(--docs-accent)] focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-[var(--docs-text)]">
                  Password
                </label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full rounded-lg border border-[var(--docs-border)] bg-[var(--docs-surface)] px-3 py-2 text-xs text-[var(--docs-text)] focus:border-[var(--docs-accent)] focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-[var(--docs-text)]">
                  Default Organization ID (optional)
                </label>
                <input
                  type="text"
                  value={orgInput}
                  onChange={(e) => setOrgInput(e.target.value)}
                  placeholder="org_01J9XYZ"
                  className="w-full rounded-lg border border-[var(--docs-border)] bg-[var(--docs-surface)] px-3 py-2 font-mono text-xs text-[var(--docs-text)] focus:border-[var(--docs-accent)] focus:outline-none"
                />
              </div>

              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-[var(--docs-accent)] px-4 py-2 text-xs font-medium text-white hover:bg-[var(--docs-accent-hover)] disabled:opacity-60"
                >
                  {submitting ? "Signing in..." : "Sign In"}
                </button>
              </div>
            </form>
          )}

          {statusMessage && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
              {statusMessage}
            </div>
          )}

          {errorMessage && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
              {errorMessage}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
