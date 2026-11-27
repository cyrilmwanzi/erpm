import type { ApiEndpointDoc } from "../generated/api-types.js";

export interface CodeGenerationOptions {
  baseUrl?: string;
  pathValues?: Record<string, string>;
  queryValues?: Record<string, string>;
  bodyJson?: string;
  organizationId?: string;
  includeInit?: boolean;
}

export function buildSdkInitializationSnippet(options?: {
  baseUrl?: string;
  organizationId?: string;
  authMode?: "pat" | "oauth2";
}): string {
  const baseUrl = options?.baseUrl || "https://api.scace.example";
  const orgId = options?.organizationId?.trim() || "org_01J9XYZ";

  if (options?.authMode === "oauth2") {
    return [
      `import { createScaceClient } from "@scace/sdk";`,
      ``,
      `export const sdk = createScaceClient({`,
      `  baseUrl: ${JSON.stringify(baseUrl)},`,
      `  auth: {`,
      `    type: "oauth2ClientCredentials",`,
      `    clientId: process.env.SCACE_CLIENT_ID!,`,
      `    clientSecret: process.env.SCACE_CLIENT_SECRET!,`,
      `    scope: "order:read invoice:read",`,
      `  },`,
      `  organizationId: ${JSON.stringify(orgId)},`,
      `});`,
    ].join("\n");
  }

  return [
    `import { createScaceClient } from "@scace/sdk";`,
    ``,
    `export const sdk = createScaceClient({`,
    `  baseUrl: ${JSON.stringify(baseUrl)},`,
    `  auth: { type: "pat", token: process.env.SCACE_PAT! },`,
    `  organizationId: ${JSON.stringify(orgId)},`,
    `});`,
  ].join("\n");
}

export function resolveEndpointUrl(
  endpoint: ApiEndpointDoc,
  pathValues: Record<string, string> = {},
  queryValues: Record<string, string> = {},
): string {
  let path = endpoint.path;
  for (const param of endpoint.pathParams) {
    const val = pathValues[param.key]?.trim() || `<${param.key}>`;
    path = path.replace(
      new RegExp(`:${param.key}\\b`, "g"),
      val === `<${param.key}>` ? val : encodeURIComponent(val),
    );
  }

  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(queryValues)) {
    if (v !== undefined && v !== "") {
      search.set(k, v);
    }
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export function buildSdkSnippet(
  endpoint: ApiEndpointDoc,
  options: CodeGenerationOptions = {},
): string {
  const baseUrl = options.baseUrl || "https://api.scace.example";
  const orgId = options.organizationId?.trim() || "org_01J9XYZ";
  const parts: string[] = [];

  if (options.includeInit) {
    parts.push(
      `import { createScaceClient } from "@scace/sdk";`,
      ``,
      `const sdk = createScaceClient({`,
      `  baseUrl: ${JSON.stringify(baseUrl)},`,
    );

    if (endpoint.authMode !== "public") {
      parts.push(`  auth: { type: "pat", token: process.env.SCACE_PAT! },`);
    }
    if (endpoint.authMode === "organization") {
      parts.push(`  organizationId: ${JSON.stringify(orgId)},`);
    }
    parts.push(`});`, ``);
  }

  const args: string[] = [];
  for (const p of endpoint.pathParams) {
    const val = options.pathValues?.[p.key]?.trim() || `${p.key}_01J9XYZ`;
    args.push(JSON.stringify(val));
  }

  if (endpoint.isMultipart) {
    args.push(
      `{\n  file: fileBytes,\n  filename: "document.pdf",\n  mimeType: "application/pdf",\n  entityType: "ORGANIZATION",\n}`,
    );
  } else if (endpoint.bodyType) {
    const rawBody = options.bodyJson?.trim();
    if (rawBody) {
      args.push(rawBody);
    } else if (endpoint.sampleBody !== undefined) {
      args.push(JSON.stringify(endpoint.sampleBody, null, 2));
    } else if (!endpoint.bodyOptional) {
      args.push(`{}`);
    }
  }

  if (endpoint.queryType) {
    const activeQuery = Object.fromEntries(
      Object.entries(options.queryValues ?? {}).filter(([, v]) => v !== ""),
    );
    if (Object.keys(activeQuery).length > 0) {
      args.push(JSON.stringify(activeQuery, null, 2));
    } else if (!endpoint.queryOptional) {
      args.push(`{}`);
    }
  }

  const callChain = `sdk.${endpoint.namespace}.${endpoint.methodName}`;
  const formattedArgs = args.join(", ");

  if (args.length === 0) {
    parts.push(`const result = await ${callChain}();`);
  } else {
    parts.push(`const result = await ${callChain}(${formattedArgs});`);
  }

  return parts.join("\n");
}

export function buildCurlSnippet(
  endpoint: ApiEndpointDoc,
  options: CodeGenerationOptions = {},
): string {
  const baseUrl = (options.baseUrl || "https://api.scace.example").replace(/\/+$/, "");
  const resolvedPath = resolveEndpointUrl(
    endpoint,
    options.pathValues,
    options.queryValues,
  );
  const fullUrl = `${baseUrl}${resolvedPath}`;
  const orgId = options.organizationId?.trim() || "org_01J9XYZ";

  const lines: string[] = [`curl -X ${endpoint.httpMethod} "${fullUrl}"`];

  if (endpoint.authMode !== "public") {
    lines.push(`  -H "Authorization: Bearer $SCACE_TOKEN"`);
  }
  if (endpoint.authMode === "organization") {
    lines.push(`  -H "X-Organization-Id: ${orgId}"`);
  }

  if (endpoint.isMultipart) {
    lines.push(`  -F "file=@./document.pdf"`);
    lines.push(`  -F "entityType=ORGANIZATION"`);
  } else if (endpoint.bodyType) {
    const bodyText =
      options.bodyJson?.trim() ||
      (endpoint.sampleBody !== undefined
        ? JSON.stringify(endpoint.sampleBody, null, 2)
        : undefined);
    if (bodyText) {
      lines.push(`  -H "Content-Type: application/json"`);
      lines.push(`  -d '${bodyText.replace(/'/g, "'\\''")}'`);
    }
  }

  return lines.join(" \\\n");
}

export function methodAccentClasses(method: ApiEndpointDoc["httpMethod"]): string {
  switch (method) {
    case "GET":
      return "text-emerald-700 dark:text-emerald-400";
    case "POST":
      return "text-blue-700 dark:text-blue-400";
    case "PATCH":
    case "PUT":
      return "text-amber-700 dark:text-amber-400";
    case "DELETE":
      return "text-rose-700 dark:text-rose-400";
  }
}

export function authModeLabel(mode: ApiEndpointDoc["authMode"]): string {
  switch (mode) {
    case "public":
      return "Public (No Auth)";
    case "optional":
      return "Optional Auth";
    case "authenticated":
      return "Authenticated User";
    case "organization":
      return "Organization Scoped";
    case "systemAdmin":
      return "System Admin Only";
  }
}
