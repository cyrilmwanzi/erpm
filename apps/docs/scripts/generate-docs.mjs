#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API,
  ObjectFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
} from "typescript/unstable/sync";
import {
  isArrayLiteralExpression,
  isCallExpression,
  isClassDeclaration,
  isDecorator,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
} from "typescript/unstable/ast/is";
import { visitEachChild } from "typescript/unstable/ast/visitor";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsRoot = resolve(__dirname, "..");
const repoRoot = resolve(docsRoot, "../..");
const apiTsConfigPath = resolve(repoRoot, "apps/api/tsconfig.json");
const outDir = resolve(docsRoot, "src/generated");

const HTTP_METHOD_DECORATORS = new Map([
  ["Get", "GET"],
  ["Post", "POST"],
  ["Patch", "PATCH"],
  ["Put", "PUT"],
  ["Delete", "DELETE"],
]);

const RESERVED_IDENTIFIERS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for",
  "function", "if", "import", "in", "instanceof", "new", "null", "return", "super",
  "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while",
  "with", "as", "implements", "interface", "let", "package", "private",
  "protected", "public", "static", "yield", "any", "boolean", "constructor",
  "declare", "get", "module", "require", "number", "set", "string", "symbol",
  "type", "from", "of",
]);

function walkAst(node, visitor) {
  visitor(node);
  visitEachChild(node, (child) => {
    walkAst(child, visitor);
    return child;
  });
}

function getDecoratorNameAndArgs(decorator) {
  if (!isDecorator(decorator)) return null;
  const expr = decorator.expression;
  if (isCallExpression(expr)) {
    const fn = expr.expression;
    if (isIdentifier(fn)) return { name: fn.text, args: expr.arguments ?? [] };
    if (isPropertyAccessExpression(fn)) return { name: fn.name.text, args: expr.arguments ?? [] };
  } else if (isIdentifier(expr)) {
    return { name: expr.text, args: [] };
  }
  return null;
}

function getStringLiteralValue(node) {
  if (!node) return undefined;
  if (isStringLiteral(node)) return node.text;
  return undefined;
}

function joinPaths(prefix, suffix) {
  const cleanPrefix = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  const cleanSuffix = (suffix ?? "").replace(/^\/+|\/+$/g, "");
  const parts = [cleanPrefix, cleanSuffix].filter(Boolean);
  return parts.length > 0 ? `/${parts.join("/")}` : "/";
}

function toSafeIdentifier(name) {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_");
  if (/^[0-9]/.test(cleaned) || RESERVED_IDENTIFIERS.has(cleaned)) {
    return `${cleaned}_`;
  }
  return cleaned;
}

function quotePropName(name) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return name;
  return JSON.stringify(name);
}

function extractPermissionsArg(arg) {
  if (!arg || !isObjectLiteralExpression(arg)) return undefined;
  const result = {};
  for (const prop of arg.properties) {
    if (isPropertyAssignment(prop)) {
      const key =
        isIdentifier(prop.name) || isStringLiteral(prop.name)
          ? prop.name.text
          : undefined;
      if (!key) continue;
      if (isArrayLiteralExpression(prop.initializer)) {
        result[key] = prop.initializer.elements
          .map((el) => getStringLiteralValue(el))
          .filter(Boolean);
      }
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function splitTopLevelUnion(str) {
  const parts = [];
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let depthAngle = 0;
  let inString = false;
  let quote = "";
  let start = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (ch === "\\" && i + 1 < str.length) i++;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "(") depthParen++;
    else if (ch === ")") depthParen--;
    else if (ch === "{") depthBrace++;
    else if (ch === "}") depthBrace--;
    else if (ch === "[") depthBracket++;
    else if (ch === "]") depthBracket--;
    else if (ch === "<") depthAngle++;
    else if (ch === ">") depthAngle--;
    else if (
      ch === "|" &&
      depthParen === 0 &&
      depthBrace === 0 &&
      depthBracket === 0 &&
      depthAngle === 0
    ) {
      parts.push(str.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(str.slice(start).trim());
  return parts;
}

function stripTrailingUndefined(typeStr) {
  if (typeStr === "undefined") return "undefined";
  const parts = splitTopLevelUnion(typeStr).filter((p) => p !== "undefined");
  if (parts.length === 0) return "undefined";
  return parts.join(" | ");
}

function unwrapPromiseType(type, checker) {
  if (!type) return type;
  if (type.isObjectType() && type.getSymbol()?.name === "Promise") {
    const args = checker.getTypeArguments(type);
    return args[0] ?? type;
  }
  return type;
}

class TsTypeSerializer {
  constructor(checker) {
    this.checker = checker;
    this.activeTypeIds = new Set();
  }

  serialize(type, depth = 0) {
    if (!type) return "unknown";
    if (depth > 6) return "JsonValue";

    const flags = type.flags;
    if (flags & TypeFlags.Any) return "unknown";
    if (flags & TypeFlags.Unknown) return "unknown";
    if (flags & TypeFlags.Void) return "void";
    if (flags & TypeFlags.Undefined) return "undefined";
    if (flags & TypeFlags.Null) return "null";
    if (flags & TypeFlags.Never) return "never";
    if (flags & TypeFlags.String) return "string";
    if (flags & TypeFlags.Number) return "number";
    if (flags & TypeFlags.Boolean) return "boolean";
    if (flags & TypeFlags.BigInt) return "number";
    if (flags & TypeFlags.NonPrimitive) return "Record<string, unknown>";
    if (flags & (TypeFlags.ESSymbol | TypeFlags.UniqueESSymbol)) return "string";

    if (type.isStringLiteralType()) return JSON.stringify(type.value);
    if (type.isNumberLiteralType()) return String(type.value);
    if (type.isBooleanLiteralType()) return String(type.value);
    if (type.isBigIntLiteralType()) return String(type.value);

    if (flags & TypeFlags.EnumLiteral || flags & TypeFlags.Enum) {
      if (type.isUnionType()) return this.serializeUnion(type, depth);
      if (type.isLiteralType()) return JSON.stringify(type.value);
      return "string";
    }
    if (type.isUnionType()) return this.serializeUnion(type, depth);
    if (type.isIntersectionType()) return this.serializeIntersection(type, depth);
    if (flags & (TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) return "string";

    if (type.isTypeParameter()) {
      const constraint = this.checker.getConstraintOfTypeParameter(type);
      return constraint ? this.serialize(constraint, depth + 1) : "unknown";
    }

    if (type.isObjectType()) return this.serializeObjectType(type, depth);

    const fallback = this.checker.typeToString(type);
    if (!fallback || fallback.includes("import(")) return "unknown";
    return fallback;
  }

  serializeUnion(type, depth) {
    const members = type.getTypes();
    const serialized = [];
    const seen = new Set();
    let hasTrue = false;
    let hasFalse = false;
    for (const m of members) {
      if (m.isBooleanLiteralType()) {
        if (m.value === true) hasTrue = true;
        if (m.value === false) hasFalse = true;
        continue;
      }
      const s = this.serialize(m, depth + 1);
      if (!seen.has(s)) {
        seen.add(s);
        serialized.push(s);
      }
    }
    if (hasTrue && hasFalse && !seen.has("boolean")) {
      seen.add("boolean");
      serialized.push("boolean");
    } else if (hasTrue && !seen.has("true")) {
      serialized.push("true");
    } else if (hasFalse && !seen.has("false")) {
      serialized.push("false");
    }
    if (serialized.length === 0) return "never";
    if (serialized.length === 1) return serialized[0];
    if (
      serialized.includes("JsonValue[]") &&
      serialized.includes("string") &&
      serialized.includes("number") &&
      serialized.includes("boolean")
    ) {
      const hasNull = serialized.includes("null");
      const hasUndefined = serialized.includes("undefined");
      const base = hasNull ? "JsonValue" : "Exclude<JsonValue, null>";
      return hasUndefined ? `${base} | undefined` : base;
    }
    return serialized.join(" | ");
  }

  serializeIntersection(type, depth) {
    const parts = type.getTypes().map((m) => {
      const s = this.serialize(m, depth + 1);
      return s.includes("|") ? `(${s})` : s;
    });
    return Array.from(new Set(parts)).join(" & ");
  }

  serializeObjectType(type, depth) {
    const symbol = type.getSymbol();
    const aliasSymbol = type.getAliasSymbol();
    const symName = symbol?.name ?? "";
    const aliasName = aliasSymbol?.name ?? "";

    if (symName === "Date") return "string";
    if (symName === "Buffer" || symName === "Uint8Array" || symName === "ArrayBuffer") {
      return "BinaryFile";
    }
    if (symName === "Decimal" || aliasName === "Decimal" || symName === "DecimalJsLike") {
      return "string | number";
    }
    if (
      aliasName === "JsonValue" ||
      aliasName === "InputJsonValue" ||
      aliasName === "NullableJsonNullValueInput" ||
      (symName === "JsonObject" && aliasName === "JsonValue")
    ) {
      return "JsonValue";
    }
    if (symName === "JsonArray" || aliasName === "JsonArray") return "JsonValue[]";
    if (symName === "JsonObject" || aliasName === "JsonObject") return "Record<string, JsonValue>";
    if (symName === "Promise") {
      const args = this.checker.getTypeArguments(type);
      return args[0] ? this.serialize(args[0], depth) : "void";
    }
    if (symName === "FastifyReply") return "unknown";

    if (this.checker.isTupleType(type)) {
      const args = this.checker.getTypeArguments(type);
      return `[${args.map((a) => this.serialize(a, depth + 1)).join(", ")}]`;
    }
    if (this.checker.isArrayType(type) || symName === "Array" || symName === "ReadonlyArray") {
      const args = this.checker.getTypeArguments(type);
      const elemType = args[0] ? this.serialize(args[0], depth + 1) : "unknown";
      const wrapped = elemType.includes("|") || elemType.includes("&") ? `(${elemType})` : elemType;
      return `${wrapped}[]`;
    }
    if (symName === "Record" || aliasName === "Record") {
      const typeArgs =
        type.getAliasTypeArguments().length > 0
          ? type.getAliasTypeArguments()
          : this.checker.getTypeArguments(type);
      if (typeArgs.length >= 2) {
        return `Record<${this.serialize(typeArgs[0], depth + 1)}, ${this.serialize(typeArgs[1], depth + 1)}>`;
      }
    }

    if (type.id && this.activeTypeIds.has(type.id)) return "JsonValue";
    if (type.id) this.activeTypeIds.add(type.id);

    try {
      const props = this.checker.getPropertiesOfType(type);
      const indexInfos = this.checker.getIndexInfosOfType(type);

      if (props.length === 0 && indexInfos.length === 0) {
        if (type.objectFlags & ObjectFlags.Mapped) return "Record<string, unknown>";
        return "Record<string, never>";
      }

      const propNames = new Set(props.map((p) => p.name));
      if (
        propNames.has("length") &&
        propNames.has("push") &&
        propNames.has("pop") &&
        propNames.has("map")
      ) {
        const numIdx = indexInfos.find(
          (info) => this.serialize(info.keyType, depth + 1) === "number",
        );
        const elemStr = numIdx ? this.serialize(numIdx.valueType, depth + 1) : "JsonValue";
        const wrapped = elemStr.includes("|") || elemStr.includes("&") ? `(${elemStr})` : elemStr;
        return `${wrapped}[]`;
      }

      const lines = [];
      const extraIndexIntersections = [];
      for (const prop of props) {
        if (prop.name.startsWith("__@")) continue;
        const isOptional = Boolean(prop.flags & SymbolFlags.Optional);
        const propType = this.checker.getTypeOfSymbol(prop);
        let typeStr = this.serialize(propType, depth + 1);
        if (isOptional) typeStr = stripTrailingUndefined(typeStr);
        lines.push(`${quotePropName(prop.name)}${isOptional ? "?" : ""}: ${typeStr};`);
      }

      for (const info of indexInfos) {
        const keyStr = this.serialize(info.keyType, depth + 1);
        const valStr = this.serialize(info.valueType, depth + 1);
        if (keyStr === "string" || keyStr === "number" || keyStr === "symbol") {
          lines.push(`[key: ${keyStr}]: ${valStr};`);
        } else {
          extraIndexIntersections.push(`Record<${keyStr}, ${valStr}>`);
        }
      }

      if (lines.length === 0 && extraIndexIntersections.length === 0) return "Record<string, unknown>";
      if (lines.length === 0) return extraIndexIntersections.join(" & ");
      const objText = `{ ${lines.join(" ")} }`;
      return extraIndexIntersections.length > 0
        ? `${objText} & ${extraIndexIntersections.join(" & ")}`
        : objText;
    } finally {
      if (type.id) this.activeTypeIds.delete(type.id);
    }
  }

  serializeZodSchema(zodSchemaType) {
    const zodProp = this.checker.getPropertyOfType(zodSchemaType, "_zod");
    if (!zodProp) return this.serialize(zodSchemaType, 0);
    const zodInternal = this.checker.getTypeOfSymbol(zodProp);
    const inputProp = this.checker.getPropertyOfType(zodInternal, "input");
    const outputProp = this.checker.getPropertyOfType(zodInternal, "output");
    const inputType = inputProp ? this.checker.getTypeOfSymbol(inputProp) : undefined;
    const outputType = outputProp ? this.checker.getTypeOfSymbol(outputProp) : undefined;
    if (!inputType) return outputType ? this.serialize(outputType, 0) : "Record<string, unknown>";
    return this.mergeZodInputOutput(inputType, outputType, 0);
  }

  mergeZodInputOutput(inputType, outputType, depth) {
    if (depth > 6) return "JsonValue";
    if (inputType.flags & TypeFlags.Unknown && outputType && !(outputType.flags & TypeFlags.Unknown)) {
      return this.serialize(outputType, depth);
    }
    if (
      inputType.isObjectType() &&
      outputType?.isObjectType() &&
      !this.checker.isArrayType(inputType) &&
      !this.checker.isTupleType(inputType)
    ) {
      const inputProps = this.checker.getPropertiesOfType(inputType);
      const outputProps = new Map(
        this.checker.getPropertiesOfType(outputType).map((p) => [p.name, p]),
      );
      const indexInfos = this.checker.getIndexInfosOfType(inputType);
      if (inputProps.length > 0 || indexInfos.length > 0) {
        const lines = [];
        for (const prop of inputProps) {
          if (prop.name.startsWith("__@")) continue;
          const isOptional = Boolean(prop.flags & SymbolFlags.Optional);
          const inPropType = this.checker.getTypeOfSymbol(prop);
          const outPropSym = outputProps.get(prop.name);
          const outPropType = outPropSym ? this.checker.getTypeOfSymbol(outPropSym) : undefined;
          let propStr = inPropType
            ? this.mergeZodInputOutput(inPropType, outPropType, depth + 1)
            : "unknown";
          if (isOptional) propStr = stripTrailingUndefined(propStr);
          lines.push(`${quotePropName(prop.name)}${isOptional ? "?" : ""}: ${propStr};`);
        }
        for (const info of indexInfos) {
          const outInfo = this.checker.getIndexInfosOfType(outputType)[0];
          const keyStr = this.serialize(info.keyType, depth + 1);
          const valStr = this.mergeZodInputOutput(info.valueType, outInfo?.valueType, depth + 1);
          if (keyStr === "string" || keyStr === "number" || keyStr === "symbol") {
            lines.push(`[key: ${keyStr}]: ${valStr};`);
          }
        }
        return `{ ${lines.join(" ")} }`;
      }
    }
    if (inputType.isUnionType()) {
      const members = inputType.getTypes();
      if (members.some((m) => m.flags & TypeFlags.Unknown) && outputType) {
        const cleanOut = this.serialize(outputType, depth);
        if (members.some((m) => m.flags & TypeFlags.Undefined)) {
          return cleanOut.includes("undefined") ? cleanOut : `${cleanOut} | undefined`;
        }
        return cleanOut;
      }
    }
    return this.serialize(inputType, depth);
  }
}

function splitTopLevelProps(inner) {
  const props = [];
  let depth = 0;
  let start = 0;
  let inStr = false;
  let q = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      if (ch === "\\" && i + 1 < inner.length) i++;
      else if (ch === q) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = true;
      q = ch;
    } else if (ch === "{" || ch === "(" || ch === "[" || ch === "<") depth++;
    else if (ch === "}" || ch === ")" || ch === "]" || ch === ">") depth--;
    else if (ch === ";" && depth === 0) {
      const seg = inner.slice(start, i).trim();
      if (seg) props.push(seg);
      start = i + 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail) props.push(tail);
  return props;
}

function canTypeBeOmitted(typeStr) {
  if (!typeStr.startsWith("{") || !typeStr.endsWith("}")) return false;
  const inner = typeStr.slice(1, -1).trim();
  if (!inner) return true;
  const props = splitTopLevelProps(inner);
  return props.every((p) => {
    if (p.startsWith("[key:")) return true;
    const colonIdx = p.indexOf(":");
    if (colonIdx === -1) return false;
    return p.slice(0, colonIdx).trim().endsWith("?");
  });
}

function unwrapOuterObjectType(typeStr) {
  const t = typeStr.trim();
  const unionParts = splitTopLevelUnion(t).filter((p) => p !== "null" && p !== "undefined");
  if (unionParts.length === 1 && unionParts[0] !== t) {
    return unwrapOuterObjectType(unionParts[0]);
  }
  return t;
}

function parseObjectFields(typeStr, depth = 0) {
  if (!typeStr || depth > 3) return [];
  const trimmed = unwrapOuterObjectType(typeStr);
  if (trimmed.endsWith("[]")) {
    let elem = trimmed.slice(0, -2).trim();
    if (elem.startsWith("(") && elem.endsWith(")")) elem = elem.slice(1, -1).trim();
    return parseObjectFields(elem, depth + 1);
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const rawProps = splitTopLevelProps(inner);
  const fields = [];
  for (const prop of rawProps) {
    if (prop.startsWith("[key:")) continue;
    const colonIdx = prop.indexOf(":");
    if (colonIdx === -1) continue;
    const rawKey = prop.slice(0, colonIdx).trim();
    const optional = rawKey.endsWith("?");
    const name = rawKey.replace(/\?$/, "").replace(/^"|"$/g, "");
    const rawType = prop.slice(colonIdx + 1).trim();
    const unionParts = splitTopLevelUnion(rawType);
    const nullable = unionParts.includes("null");
    const nonNullParts = unionParts.filter((p) => p !== "null" && p !== "undefined");
    const cleanType = nonNullParts.join(" | ") || rawType;
    const enumValues =
      nonNullParts.length > 1 && nonNullParts.every((p) => /^"[^"]*"$/.test(p))
        ? nonNullParts.map((p) => p.slice(1, -1))
        : undefined;

    let children = [];
    if (cleanType.startsWith("{") && cleanType.endsWith("}")) {
      children = parseObjectFields(cleanType, depth + 1);
    } else if (cleanType.endsWith("[]")) {
      let innerElem = cleanType.slice(0, -2).trim();
      if (innerElem.startsWith("(") && innerElem.endsWith(")")) {
        innerElem = innerElem.slice(1, -1).trim();
      }
      if (innerElem.startsWith("{") && innerElem.endsWith("}")) {
        children = parseObjectFields(innerElem, depth + 1);
      }
    }

    fields.push({
      name,
      type: cleanType.length > 140 ? `${cleanType.slice(0, 137)}...` : cleanType,
      required: !optional,
      ...(nullable ? { nullable: true } : {}),
      ...(enumValues ? { enumValues } : {}),
      ...(children.length > 0 ? { children } : {}),
    });
  }
  return fields;
}

function sampleValueForField(fieldName, typeStr, depth = 0) {
  if (depth > 3) return {};
  const lower = fieldName.toLowerCase();
  const unionParts = splitTopLevelUnion(typeStr).filter((p) => p !== "null" && p !== "undefined");
  const primary = unionParts[0] ?? typeStr;

  if (/^"[^"]*"$/.test(primary)) return primary.slice(1, -1);
  if (primary === "true" || primary === "false") return primary === "true";
  if (/^\d+$/.test(primary)) return Number(primary);

  if (primary.startsWith("{") && primary.endsWith("}")) {
    const obj = {};
    const fields = parseObjectFields(primary, depth);
    for (const f of fields.slice(0, 8)) {
      if (!f.required && Object.keys(obj).length >= 5) continue;
      obj[f.name] = sampleValueForField(f.name, f.type, depth + 1);
    }
    return obj;
  }

  if (primary.endsWith("[]")) {
    let elem = primary.slice(0, -2).trim();
    if (elem.startsWith("(") && elem.endsWith(")")) elem = elem.slice(1, -1).trim();
    return [sampleValueForField(fieldName, elem, depth + 1)];
  }

  if (primary === "boolean") return true;
  if (primary === "number") {
    if (lower.includes("limit")) return 25;
    if (lower.includes("month")) return 1;
    if (lower.includes("amount") || lower.includes("cents") || lower.includes("price")) return 25000;
    if (lower.includes("qty") || lower.includes("quantity")) return 10;
    if (lower.includes("days")) return 7;
    return 1;
  }
  if (primary.startsWith("Record<")) return {};
  if (primary === "BinaryFile") return "<binary-file>";

  // Contextual string defaults
  if (lower.includes("email")) return "ops@acme.co.ke";
  if (lower.includes("phone")) return "254712345678";
  if (lower.includes("currency")) return "KES";
  if (lower.includes("timezone")) return "Africa/Nairobi";
  if (lower.includes("role")) return "admin";
  if (lower.includes("url") || lower.includes("endpoint") || lower.includes("uri")) {
    return "https://api.example.com/webhooks/scace";
  }
  if (lower.includes("date") || lower.endsWith("at")) return "2026-12-31T00:00:00.000Z";
  if (lower.includes("sku")) return "ESP-250G";
  if (lower.includes("code") && lower.includes("plan")) return "GROWTH";
  if (lower.includes("shortcode")) return "174379";
  if (lower.includes("slug")) return "acme-roasters";
  if (lower.includes("name")) return "Acme Operations";
  if (lower === "id" || lower.endsWith("id")) return `${fieldName.replace(/Id$/i, "").toLowerCase() || "rec"}_01J9XYZ`;
  return "string";
}

function buildSampleObjectFromType(typeStr) {
  if (!typeStr) return undefined;
  const trimmed = typeStr.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return sampleValueForField("body", trimmed, 0);
  }
  const unionParts = splitTopLevelUnion(trimmed);
  const firstObj = unionParts.find((p) => p.trim().startsWith("{"));
  if (firstObj) return sampleValueForField("body", firstObj.trim(), 0);
  return undefined;
}

const NAMESPACE_LABELS = {
  auth: { title: "Authentication & Sessions", category: "Identity & Access" },
  "auth.pats": { title: "Personal Access Tokens", category: "Identity & Access" },
  "auth.oauthClients": { title: "OAuth2 Clients", category: "Identity & Access" },
  "auth.devices": { title: "Device Terminals", category: "Identity & Access" },
  "auth.oauth": { title: "OAuth2 & OIDC Provider", category: "Identity & Access" },
  "auth.sso": { title: "Enterprise SSO", category: "Identity & Access" },
  organizations: { title: "Organizations & RBAC", category: "Organization & Governance" },
  invitations: { title: "Organization Invitations", category: "Organization & Governance" },
  billing: { title: "Organization Billing", category: "Billing & Payments" },
  systemBilling: { title: "System Billing Admin", category: "Billing & Payments" },
  payments: { title: "Payments & M-Pesa", category: "Billing & Payments" },
  receipts: { title: "Receipts", category: "Sales & Commerce" },
  orders: { title: "Orders & POS Checkout", category: "Sales & Commerce" },
  invoices: { title: "Sales Invoices", category: "Sales & Commerce" },
  fulfillments: { title: "Order Fulfillment", category: "Sales & Commerce" },
  pricing: { title: "Pricing Engine", category: "Sales & Commerce" },
  customers: { title: "Customers", category: "Sales & Commerce" },
  crm: { title: "CRM Connections", category: "Sales & Commerce" },
  items: { title: "Catalog Items", category: "Catalog & Inventory" },
  variants: { title: "Product Variants", category: "Catalog & Inventory" },
  locations: { title: "Locations & Warehouses", category: "Catalog & Inventory" },
  inventory: { title: "Stock Balances & Transfers", category: "Catalog & Inventory" },
  expiry: { title: "Stock Expiry & FEFO", category: "Catalog & Inventory" },
  suppliers: { title: "Suppliers", category: "Supply Chain & Production" },
  purchaseOrders: { title: "Purchase Orders", category: "Supply Chain & Production" },
  deliveries: { title: "Goods Receiving", category: "Supply Chain & Production" },
  vendorBills: { title: "Vendor Bills", category: "Supply Chain & Production" },
  engineering: { title: "BOM & Work Centers", category: "Supply Chain & Production" },
  production: { title: "Production Batches", category: "Supply Chain & Production" },
  reports: { title: "Reporting & Exports", category: "Reporting & Communications" },
  communications: { title: "Communications Outbox", category: "Reporting & Communications" },
  staff: { title: "Staff Directory", category: "Workforce & Operations" },
  departments: { title: "Departments", category: "Workforce & Operations" },
  teams: { title: "Teams", category: "Workforce & Operations" },
  schedules: { title: "Work Schedules", category: "Workforce & Operations" },
  holidays: { title: "Holidays", category: "Workforce & Operations" },
  timeOff: { title: "Time Off Requests", category: "Workforce & Operations" },
  calendar: { title: "Availability & Calendar", category: "Workforce & Operations" },
  staffJobs: { title: "Staff Jobs", category: "Workforce & Operations" },
  storage: { title: "Object Storage", category: "Platform & Observability" },
  health: { title: "Health Probes", category: "Platform & Observability" },
  observability: { title: "Observability", category: "Platform & Observability" },
  system: { title: "Service Discovery", category: "Platform & Observability" },
};

function mapControllerMethodToNamespace(controllerName, fullPath, methodName) {
  if (controllerName === "MeController") return { namespacePath: ["auth"], sdkMethodName: "me" };
  if (controllerName === "PatController") {
    const map = {
      listAvailableScopes: "listScopes",
      createPat: "create",
      listPats: "list",
      revokePatPost: "revoke",
      revokePatDelete: "delete",
    };
    return { namespacePath: ["auth", "pats"], sdkMethodName: map[methodName] ?? methodName };
  }
  if (controllerName === "OAuthClientsController") {
    if (fullPath.startsWith("/api/v1/auth/devices")) {
      const map = {
        listDevices: "list",
        updateDevice: "update",
        revokeDevicePost: "revoke",
        revokeDeviceDelete: "delete",
      };
      return { namespacePath: ["auth", "devices"], sdkMethodName: map[methodName] ?? methodName };
    }
    const map = {
      createClient: "create",
      listClients: "list",
      getClient: "get",
      updateClient: "update",
      rotateSecret: "rotateSecret",
      addPublicKey: "addPublicKey",
      listPublicKeys: "listPublicKeys",
      revokePublicKey: "revokePublicKey",
    };
    return { namespacePath: ["auth", "oauthClients"], sdkMethodName: map[methodName] ?? methodName };
  }
  if (controllerName === "OAuthProviderController") {
    return { namespacePath: ["auth", "oauth"], sdkMethodName: methodName };
  }
  if (controllerName === "SsoController") {
    return { namespacePath: ["auth", "sso"], sdkMethodName: methodName };
  }
  if (controllerName === "ReceiptsController") {
    if (fullPath.startsWith("/api/v1/payments")) return { namespacePath: ["payments"], sdkMethodName: methodName };
    return { namespacePath: ["receipts"], sdkMethodName: methodName };
  }
  if (controllerName === "SchedulesLeaveController") {
    if (fullPath.startsWith("/api/v1/holidays")) return { namespacePath: ["holidays"], sdkMethodName: methodName };
    if (fullPath.startsWith("/api/v1/time-off")) return { namespacePath: ["timeOff"], sdkMethodName: methodName };
    return { namespacePath: ["schedules"], sdkMethodName: methodName };
  }

  const directMap = {
    RootController: ["system"],
    HealthController: ["health"],
    ObservabilityController: ["observability"],
    OrganizationsController: ["organizations"],
    InvitationsController: ["invitations"],
    ItemsController: ["items"],
    VariantsController: ["variants"],
    LocationsController: ["locations"],
    InventoryController: ["inventory"],
    SuppliersController: ["suppliers"],
    PurchaseOrdersController: ["purchaseOrders"],
    DeliveriesController: ["deliveries"],
    VendorBillsController: ["vendorBills"],
    ProductionEngineeringController: ["engineering"],
    ProductionController: ["production"],
    ProductionExecutionController: ["production"],
    PricingController: ["pricing"],
    CustomersController: ["customers"],
    CrmController: ["crm"],
    OrdersController: ["orders"],
    InvoicesController: ["invoices"],
    FulfillmentsController: ["fulfillments"],
    StaffJobsController: ["staffJobs"],
    StaffController: ["staff"],
    DepartmentsController: ["departments"],
    TeamsController: ["teams"],
    AvailabilityCalendarController: ["calendar"],
    CalendarController: ["calendar"],
    StorageController: ["storage"],
    ExpiryController: ["expiry"],
    ReportsController: ["reports"],
    CommunicationsController: ["communications"],
    SystemBillingController: ["systemBilling"],
    OrgBillingController: ["billing"],
  };

  const namespacePath = directMap[controllerName] ?? [
    controllerName.replace(/Controller$/, "").replace(/^./, (c) => c.toLowerCase()),
  ];
  return { namespacePath, sdkMethodName: methodName };
}

function humanizeMethodName(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function main() {
  const api = new API({ cwd: repoRoot });
  const snap = api.updateSnapshot({ openProject: apiTsConfigPath });
  const project = snap.getProject(apiTsConfigPath);
  if (!project) throw new Error(`Unable to load project: ${apiTsConfigPath}`);

  const { program, checker } = project;
  const serializer = new TsTypeSerializer(checker);

  const controllerFiles = program
    .getSourceFileNames()
    .filter(
      (f) =>
        f.includes("/apps/api/src/") &&
        f.endsWith(".controller.ts") &&
        !f.endsWith(".spec.ts") &&
        !f.endsWith(".test.ts"),
    )
    .sort();

  const endpoints = [];
  const usedIds = new Set();

  for (const fileName of controllerFiles) {
    const sf = program.getSourceFile(fileName);
    if (!sf) continue;
    const relFile = relative(repoRoot, fileName).replace(/\\/g, "/");

    for (const stmt of sf.statements) {
      if (!isClassDeclaration(stmt) || !stmt.name) continue;
      const controllerName = stmt.name.text;
      const classDecorators = (stmt.modifiers ?? []).filter(isDecorator);

      let controllerPrefix = null;
      let classRequiresOrganization = false;
      let classAllowAnonymous = false;
      let classOptionalAuth = false;
      let classRequireSystemAdmin = false;
      let classBillingExempt = false;
      let classBillingFeature = undefined;
      let classPermissions = undefined;

      for (const dec of classDecorators) {
        const info = getDecoratorNameAndArgs(dec);
        if (!info) continue;
        if (info.name === "Controller") controllerPrefix = getStringLiteralValue(info.args[0]) ?? "";
        else if (info.name === "RequireActiveOrganization") classRequiresOrganization = true;
        else if (info.name === "AllowAnonymous") classAllowAnonymous = true;
        else if (info.name === "OptionalAuth") classOptionalAuth = true;
        else if (info.name === "RequireSystemAdmin") classRequireSystemAdmin = true;
        else if (info.name === "AllowWhenBillingLocked") classBillingExempt = true;
        else if (info.name === "RequiredBillingFeature") {
          classBillingFeature = getStringLiteralValue(info.args[0]);
        } else if (info.name === "RequiredOrgPermissions") {
          classPermissions = extractPermissionsArg(info.args[0]);
        }
      }
      if (controllerPrefix === null) continue;

      for (const member of stmt.members) {
        if (!isMethodDeclaration(member) || !member.name) continue;
        const methodName = member.name.text;
        const methodDecorators = (member.modifiers ?? []).filter(isDecorator);

        let httpMethod = null;
        let methodRoutePath = "";
        let methodRequiresOrganization = classRequiresOrganization;
        let methodAllowAnonymous = classAllowAnonymous;
        let methodOptionalAuth = classOptionalAuth;
        let methodRequireSystemAdmin = classRequireSystemAdmin;
        let methodBillingExempt = classBillingExempt;
        let methodBillingFeature = classBillingFeature;
        let methodPermissions = classPermissions;

        for (const dec of methodDecorators) {
          const info = getDecoratorNameAndArgs(dec);
          if (!info) continue;
          if (HTTP_METHOD_DECORATORS.has(info.name)) {
            httpMethod = HTTP_METHOD_DECORATORS.get(info.name);
            methodRoutePath = getStringLiteralValue(info.args[0]) ?? "";
          } else if (info.name === "RequireActiveOrganization") methodRequiresOrganization = true;
          else if (info.name === "AllowAnonymous") methodAllowAnonymous = true;
          else if (info.name === "OptionalAuth") methodOptionalAuth = true;
          else if (info.name === "RequireSystemAdmin") methodRequireSystemAdmin = true;
          else if (info.name === "AllowWhenBillingLocked") methodBillingExempt = true;
          else if (info.name === "RequiredBillingFeature") {
            methodBillingFeature = getStringLiteralValue(info.args[0]);
          } else if (info.name === "RequiredOrgPermissions") {
            methodPermissions = extractPermissionsArg(info.args[0]);
          }
        }
        if (!httpMethod) continue;

        const fullPath = joinPaths(controllerPrefix, methodRoutePath);
        const pathParams = [];
        const inlineQueryProps = [];
        let bodyParamName = null;
        let bodyParamTypeNode = null;
        let queryParamName = null;
        let queryParamTypeNode = null;
        let hasResDecorator = false;

        for (const param of member.parameters) {
          if (!isParameterDeclaration(param) || !isIdentifier(param.name)) continue;
          const pName = param.name.text;
          const pDecs = (param.modifiers ?? []).filter(isDecorator);
          for (const pDec of pDecs) {
            const pInfo = getDecoratorNameAndArgs(pDec);
            if (!pInfo) continue;
            if (pInfo.name === "Param") {
              const routeParamKey = getStringLiteralValue(pInfo.args[0]) ?? pName;
              const pType = checker.getTypeAtLocation(param.name);
              pathParams.push({
                key: routeParamKey,
                argName: toSafeIdentifier(routeParamKey),
                type: serializer.serialize(pType, 0) || "string",
              });
            } else if (pInfo.name === "Body") {
              bodyParamName = pName;
              bodyParamTypeNode = param.type ?? null;
            } else if (pInfo.name === "Query") {
              const qKey = getStringLiteralValue(pInfo.args[0]);
              if (qKey) {
                const qType = checker.getTypeAtLocation(param.name);
                const isOpt = Boolean(param.questionToken || param.initializer);
                const qTypeStr = stripTrailingUndefined(serializer.serialize(qType, 0) || "string");
                inlineQueryProps.push(`${quotePropName(qKey)}${isOpt ? "?" : ""}: ${qTypeStr};`);
              } else {
                queryParamName = pName;
                queryParamTypeNode = param.type ?? null;
              }
            } else if (pInfo.name === "Res") {
              hasResDecorator = true;
            }
          }
        }

        let bodyZodNode = null;
        let queryZodNode = null;
        let bodyFallsBackToEmptyObject = false;
        let queryFallsBackToEmptyObject = false;
        let isMultipart = false;
        let detectedContentType = null;
        let sendsBinaryStream = false;

        if (member.body) {
          walkAst(member.body, (node) => {
            if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
              const fnName = node.expression.name.text;
              if (fnName === "isMultipart") isMultipart = true;
              else if (fnName === "header" && node.arguments?.length >= 2) {
                const hName = getStringLiteralValue(node.arguments[0]);
                const hVal = getStringLiteralValue(node.arguments[1]);
                if (hName?.toLowerCase() === "content-type" && hVal) detectedContentType = hVal.toLowerCase();
              } else if (fnName === "send" && node.arguments?.length >= 1) {
                const argText = node.arguments[0];
                if (isPropertyAccessExpression(argText) && argText.name.text === "body") sendsBinaryStream = true;
              } else if ((fnName === "safeParse" || fnName === "parse") && node.arguments?.length >= 1) {
                const schemaExpr = node.expression.expression;
                const targetArg = node.arguments[0];
                const targetText = isIdentifier(targetArg)
                  ? targetArg.text
                  : targetArg.left && isIdentifier(targetArg.left)
                    ? targetArg.left.text
                    : null;
                const hasEmptyFallback = Boolean(targetArg.left && targetArg.right);
                if (bodyParamName && targetText === bodyParamName && !bodyZodNode) {
                  bodyZodNode = schemaExpr;
                  bodyFallsBackToEmptyObject = hasEmptyFallback;
                } else if (queryParamName && targetText === queryParamName && !queryZodNode) {
                  queryZodNode = schemaExpr;
                  queryFallsBackToEmptyObject = hasEmptyFallback;
                }
              }
            }
          });
        }

        let bodyTypeStr = null;
        let bodyOptional = false;
        if (isMultipart) {
          bodyTypeStr = `{ file: BinaryFile; filename?: string; mimeType?: string; entityType?: "ORGANIZATION" | "ITEM" | "VENDOR_BILL" | "PURCHASE_ORDER" | "GOODS_RECEIPT" | "STOCK_LOT" | "PRODUCTION_BATCH" | "SUPPLIER" | "CUSTOMER" | "ORDER" | "SALES_INVOICE" | "PAYMENT_RECEIPT"; entityId?: string | null; tags?: string[]; metadata?: Record<string, unknown> | null; }`;
        } else if (bodyZodNode) {
          bodyTypeStr = serializer.serializeZodSchema(checker.getTypeAtLocation(bodyZodNode));
          bodyOptional = bodyFallsBackToEmptyObject || canTypeBeOmitted(bodyTypeStr);
        } else if (bodyParamName) {
          bodyTypeStr = bodyParamTypeNode
            ? serializer.serialize(checker.getTypeFromTypeNode(bodyParamTypeNode), 0)
            : "Record<string, unknown>";
          bodyOptional = canTypeBeOmitted(bodyTypeStr);
        }

        let queryTypeStr = null;
        let queryOptional = true;
        if (inlineQueryProps.length > 0) {
          queryTypeStr = `{ ${inlineQueryProps.join(" ")} }`;
          queryOptional = canTypeBeOmitted(queryTypeStr);
        } else if (queryZodNode) {
          queryTypeStr = serializer.serializeZodSchema(checker.getTypeAtLocation(queryZodNode));
          queryOptional = queryFallsBackToEmptyObject || canTypeBeOmitted(queryTypeStr);
        } else if (queryParamName) {
          queryTypeStr = queryParamTypeNode
            ? serializer.serialize(checker.getTypeFromTypeNode(queryParamTypeNode), 0)
            : "Record<string, string | number | boolean | undefined>";
        }

        let responseKind = "json";
        let returnTypeStr = "unknown";
        if (
          sendsBinaryStream ||
          detectedContentType?.includes("application/pdf") ||
          detectedContentType?.includes("application/octet-stream") ||
          hasResDecorator
        ) {
          responseKind = "binary";
          returnTypeStr = "BinaryResponse";
        } else if (
          detectedContentType?.includes("text/html") ||
          detectedContentType?.includes("text/calendar") ||
          detectedContentType?.includes("text/plain")
        ) {
          responseKind = "text";
          returnTypeStr = "string";
        } else {
          const sym = checker.getSymbolAtLocation(member.name);
          const fnType = sym ? checker.getTypeOfSymbol(sym) : undefined;
          const sig = fnType ? checker.getSignaturesOfType(fnType, SignatureKind.Call)[0] : undefined;
          const rawRet = sig ? checker.getReturnTypeOfSignature(sig) : undefined;
          const awaitedRet = unwrapPromiseType(rawRet, checker);
          returnTypeStr = awaitedRet ? serializer.serialize(awaitedRet, 0) : "void";
        }

        const { namespacePath, sdkMethodName } = mapControllerMethodToNamespace(
          controllerName,
          fullPath,
          methodName,
        );
        const namespace = namespacePath.join(".");
        let id = `${namespace}.${sdkMethodName}`;
        let suffix = 2;
        while (usedIds.has(id)) {
          id = `${namespace}.${sdkMethodName}${suffix++}`;
        }
        usedIds.add(id);

        const authMode = methodRequireSystemAdmin
          ? "systemAdmin"
          : methodAllowAnonymous
            ? "public"
            : methodOptionalAuth
              ? "optional"
              : methodRequiresOrganization
                ? "organization"
                : "authenticated";

        const queryFields = queryTypeStr ? parseObjectFields(queryTypeStr) : [];
        const bodyFields = bodyTypeStr ? parseObjectFields(bodyTypeStr) : [];
        const responseFields = returnTypeStr ? parseObjectFields(returnTypeStr) : [];
        const sampleBody = bodyTypeStr ? buildSampleObjectFromType(bodyTypeStr) : undefined;

        endpoints.push({
          id,
          namespace,
          methodName: sdkMethodName,
          title: humanizeMethodName(sdkMethodName),
          httpMethod,
          path: fullPath,
          authMode,
          ...(methodPermissions ? { permissions: methodPermissions } : {}),
          ...(methodBillingExempt ? { billingExempt: true } : {}),
          ...(methodBillingFeature ? { billingFeature: methodBillingFeature } : {}),
          isMultipart,
          responseKind,
          controller: controllerName,
          sourceFile: relFile,
          pathParams,
          queryOptional,
          queryType: queryTypeStr,
          queryFields,
          bodyOptional,
          bodyType: bodyTypeStr,
          bodyFields,
          ...(sampleBody !== undefined ? { sampleBody } : {}),
          responseType: returnTypeStr,
          responseFields,
        });
      }
    }
  }

  snap.dispose();
  api.close();

  // Group into clean ordered namespaces
  const groupMap = new Map();
  for (const ep of endpoints) {
    if (!groupMap.has(ep.namespace)) {
      const meta = NAMESPACE_LABELS[ep.namespace] ?? {
        title: humanizeMethodName(ep.namespace.replace(/\./g, " ")),
        category: "API Reference",
      };
      groupMap.set(ep.namespace, {
        namespace: ep.namespace,
        slug: ep.namespace.replace(/\./g, "-"),
        title: meta.title,
        category: meta.category,
        endpoints: [],
      });
    }
    groupMap.get(ep.namespace).endpoints.push(ep);
  }

  const namespaces = Array.from(groupMap.values()).map((g) => ({
    namespace: g.namespace,
    slug: g.slug,
    title: g.title,
    category: g.category,
    endpointCount: g.endpoints.length,
    endpoints: g.endpoints,
  }));

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  writeFileSync(
    resolve(outDir, "api-types.ts"),
    `export type EndpointAuthMode =
  | "public"
  | "optional"
  | "authenticated"
  | "organization"
  | "systemAdmin";

export interface SchemaFieldDoc {
  name: string;
  type: string;
  required: boolean;
  nullable?: boolean;
  enumValues?: string[];
  children?: SchemaFieldDoc[];
}

export interface PathParamDoc {
  key: string;
  argName: string;
  type: string;
}

export interface ApiEndpointDoc {
  id: string;
  namespace: string;
  methodName: string;
  title: string;
  httpMethod: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  authMode: EndpointAuthMode;
  permissions?: Record<string, string[]>;
  billingExempt?: boolean;
  billingFeature?: string;
  isMultipart: boolean;
  responseKind: string;
  controller: string;
  sourceFile: string;
  pathParams: PathParamDoc[];
  queryOptional: boolean;
  queryType: string | null;
  queryFields: SchemaFieldDoc[];
  bodyOptional: boolean;
  bodyType: string | null;
  bodyFields: SchemaFieldDoc[];
  sampleBody?: unknown;
  responseType: string;
  responseFields: SchemaFieldDoc[];
}

export interface ApiNamespaceGroup {
  namespace: string;
  slug: string;
  title: string;
  category: string;
  endpointCount: number;
  endpoints: ApiEndpointDoc[];
}

export interface GeneratedApiCatalog {
  generatedAt: string;
  controllerCount: number;
  endpointCount: number;
  namespaces: ApiNamespaceGroup[];
}
`,
  );

  writeFileSync(
    resolve(outDir, "api-catalog.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        controllerCount: controllerFiles.length,
        endpointCount: endpoints.length,
        namespaces,
      },
      null,
      2,
    ),
  );

  console.log(
    `[scace-docs] Generated API catalog from ${controllerFiles.length} controllers (${endpoints.length} endpoints across ${namespaces.length} namespaces)`,
  );
}

main();
