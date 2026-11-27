import { Check, Copy } from "lucide-react";
import { useState } from "react";

interface CodeBlockProps {
  code: string;
  language?: "json" | "typescript" | "bash" | "text" | "sdk" | "curl";
  label?: string;
  headerRight?: React.ReactNode;
}

interface TokenPart {
  text: string;
  className: string;
}

function tokenizeJsonLine(line: string): TokenPart[] {
  const parts: TokenPart[] = [];
  const regex =
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        text: line.slice(lastIndex, match.index),
        className: "text-slate-300",
      });
    }
    const token = match[0];
    if (token.startsWith('"')) {
      if (token.endsWith(":")) {
        parts.push({ text: token, className: "text-rose-400" });
      } else {
        parts.push({ text: token, className: "text-emerald-400" });
      }
    } else if (/^(true|false|null)$/.test(token)) {
      parts.push({ text: token, className: "text-amber-300" });
    } else {
      parts.push({ text: token, className: "text-emerald-300" });
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < line.length) {
    parts.push({ text: line.slice(lastIndex), className: "text-slate-300" });
  }
  return parts;
}

function tokenizeTsOrBashLine(
  line: string,
  language: CodeBlockProps["language"],
): TokenPart[] {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || (language === "bash" && trimmed.startsWith("#")) || (language === "curl" && trimmed.startsWith("#"))) {
    return [{ text: line, className: "text-slate-400 italic" }];
  }

  const parts: TokenPart[] = [];
  const regex =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(import|from|export|const|let|await|async|function|return|if|else|true|false|null|undefined|new|curl)\b|-X\s+(?:GET|POST|PATCH|PUT|DELETE)|-[HFd]\b)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        text: line.slice(lastIndex, match.index),
        className: "text-slate-200",
      });
    }
    const token = match[0];
    if (token.startsWith('"') || token.startsWith("'") || token.startsWith("`")) {
      parts.push({ text: token, className: "text-emerald-400" });
    } else if (token.startsWith("-")) {
      parts.push({ text: token, className: "text-sky-400" });
    } else {
      parts.push({ text: token, className: "text-violet-300" });
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < line.length) {
    parts.push({ text: line.slice(lastIndex), className: "text-slate-200" });
  }
  return parts;
}

export function CodeBlock({
  code,
  language = "text",
  label,
  headerRight,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API may be unavailable in restricted contexts
    }
  };

  const displayLabel =
    label ??
    (language === "json"
      ? "JSON"
      : language === "typescript" || language === "sdk"
        ? "TYPESCRIPT"
        : language === "bash" || language === "curl"
          ? "cURL"
          : "TEXT");

  const lines = code.split("\n");

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--docs-code-border)] bg-[var(--docs-code-bg)] text-slate-100">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--docs-code-border)] bg-[var(--docs-code-header)] px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs font-medium tracking-wide text-slate-300">
            {displayLabel}
          </span>
          {headerRight}
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 whitespace-nowrap shrink-0"
          aria-label="Copy code to clipboard"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-emerald-300">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy code</span>
            </>
          )}
        </button>
      </div>
      <pre className="docs-scroll overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-6">
        <code>
          {lines.map((line, lineIdx) => {
            const tokens =
              language === "json"
                ? tokenizeJsonLine(line)
                : language === "text"
                  ? [{ text: line, className: "text-slate-200" }]
                  : tokenizeTsOrBashLine(line, language);
            return (
              <div key={lineIdx} className="min-h-[1.5rem]">
                {tokens.length > 0 ? (
                  tokens.map((part, partIdx) => (
                    <span key={partIdx} className={part.className}>
                      {part.text}
                    </span>
                  ))
                ) : (
                  "\n"
                )}
              </div>
            );
          })}
        </code>
      </pre>
    </div>
  );
}
