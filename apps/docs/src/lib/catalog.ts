import rawCatalog from "../generated/api-catalog.json";
import type {
  ApiEndpointDoc,
  ApiNamespaceGroup,
  GeneratedApiCatalog,
} from "../generated/api-types.js";
import { GUIDE_PAGES } from "../data/guides.js";

export const API_CATALOG = rawCatalog as GeneratedApiCatalog;

const CATEGORY_ORDER = [
  "Identity & Access",
  "Organization & Governance",
  "Billing & Payments",
  "Sales & Commerce",
  "Catalog & Inventory",
  "Supply Chain & Production",
  "Reporting & Communications",
  "Workforce & Operations",
  "Platform & Observability",
  "API Reference",
];

export interface ApiCategorySection {
  category: string;
  namespaces: ApiNamespaceGroup[];
}

export function getCategorizedNamespaces(): ApiCategorySection[] {
  const map = new Map<string, ApiNamespaceGroup[]>();
  for (const ns of API_CATALOG.namespaces) {
    const list = map.get(ns.category) ?? [];
    list.push(ns);
    map.set(ns.category, list);
  }

  return Array.from(map.entries())
    .sort((a, b) => {
      const idxA = CATEGORY_ORDER.indexOf(a[0]);
      const idxB = CATEGORY_ORDER.indexOf(b[0]);
      return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
    })
    .map(([category, namespaces]) => ({
      category,
      namespaces: [...namespaces].sort((a, b) => a.title.localeCompare(b.title)),
    }));
}

export function getNamespaceBySlug(slug: string): ApiNamespaceGroup | undefined {
  return API_CATALOG.namespaces.find(
    (ns) => ns.slug === slug || ns.namespace === slug,
  );
}

export function getAllEndpoints(): ApiEndpointDoc[] {
  return API_CATALOG.namespaces.flatMap((ns) => ns.endpoints);
}

export interface SearchEntry {
  id: string;
  kind: "guide" | "endpoint";
  title: string;
  subtitle: string;
  to: string;
  hash?: string;
  httpMethod?: ApiEndpointDoc["httpMethod"];
  keywords: string;
}

export function buildSearchIndex(): SearchEntry[] {
  const entries: SearchEntry[] = [];

  for (const guide of GUIDE_PAGES) {
    entries.push({
      id: `guide:${guide.slug}`,
      kind: "guide",
      title: guide.title,
      subtitle: `${guide.groupTitle} · ${guide.subtitle}`,
      to: `/docs/${guide.slug}`,
      keywords: `${guide.title} ${guide.groupTitle} ${guide.subtitle} ${guide.lead}`.toLowerCase(),
    });

    for (const sec of guide.sections) {
      entries.push({
        id: `guide:${guide.slug}#${sec.id}`,
        kind: "guide",
        title: `${guide.title} — ${sec.heading}`,
        subtitle: guide.groupTitle,
        to: `/docs/${guide.slug}`,
        hash: sec.id,
        keywords: `${guide.title} ${sec.heading} ${guide.groupTitle}`.toLowerCase(),
      });
    }
  }

  for (const ns of API_CATALOG.namespaces) {
    for (const ep of ns.endpoints) {
      entries.push({
        id: `ep:${ep.id}`,
        kind: "endpoint",
        title: ep.title,
        subtitle: `${ep.httpMethod} ${ep.path} · ${ns.title}`,
        to: `/api/${ns.slug}`,
        hash: ep.id,
        httpMethod: ep.httpMethod,
        keywords: `${ep.httpMethod} ${ep.path} ${ep.title} ${ep.methodName} ${ns.title} ${ep.namespace} ${ep.controller}`.toLowerCase(),
      });
    }
  }

  return entries;
}
