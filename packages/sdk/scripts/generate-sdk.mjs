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
  isShorthandPropertyAssignment,
  isStringLiteral,
} from "typescript/unstable/ast/is";
import { visitEachChild } from "typescript/unstable/ast/visitor";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(__dirname, "..");
const repoRoot = resolve(sdkRoot, "../..");
const apiTsConfigPath = resolve(repoRoot, "apps/api/tsconfig.json");
const outDir = resolve(sdkRoot, "src/generated");

const HTTP_METHOD_DECORATORS = new Map([
  ["Get", "GET"],
  ["Post", "POST"],
  ["Patch", "PATCH"],
  ["Put", "PUT"],
  ["Delete", "DELETE"],
]);

const RESERVED_IDENTIFIERS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "as",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "any",
  "boolean",
  "constructor",
  "declare",
  "get",
  "module",
  "require",
  "number",
  "set",
  "string",
  "symbol",
  "type",
  "from",
  "of",
]);

function walkAst(node, visitor) {
  visitor(node);
  visitEachChild(node, (child) => {
    walkAst(child, visitor);
    return child;
  });
}

function getDecoratorNameAndArgs(decorator) {
  if (!isDecorator(decorator)) {
    return null;
  }
  const expr = decorator.expression;
  if (isCallExpression(expr)) {
    const fn = expr.expression;
    if (isIdentifier(fn)) {
      return { name: fn.text, args: expr.arguments ?? [] };
    }
    if (isPropertyAccessExpression(fn)) {
      return { name: fn.name.text, args: expr.arguments ?? [] };
    }
  } else if (isIdentifier(expr)) {
    return { name: expr.text, args: [] };
  }
  return null;
}

function getStringLiteralValue(node) {
  if (!node) {
    return undefined;
  }
  if (isStringLiteral(node)) {
    return node.text;
  }
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

function toPascalCase(str) {
  return str
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function quotePropName(name) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    return name;
  }
  return JSON.stringify(name);
}

function extractPermissionsArg(arg) {
  if (!arg || !isObjectLiteralExpression(arg)) {
    return undefined;
  }
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

/**
 * Serializes a TypeScript 7 Type object into clean, standalone client-safe TypeScript type text.
 */
class TsTypeSerializer {
  constructor(checker) {
    this.checker = checker;
    this.activeTypeIds = new Set();
  }

  serialize(type, depth = 0, options = {}) {
    if (!type) {
      return "unknown";
    }
    if (depth > 8) {
      return "JsonValue";
    }

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
    if (flags & (TypeFlags.ESSymbol | TypeFlags.UniqueESSymbol)) {
      return "string";
    }

    if (type.isStringLiteralType()) {
      return JSON.stringify(type.value);
    }
    if (type.isNumberLiteralType()) {
      return String(type.value);
    }
    if (type.isBooleanLiteralType()) {
      return String(type.value);
    }
    if (type.isBigIntLiteralType()) {
      return String(type.value);
    }

    if (flags & TypeFlags.EnumLiteral || flags & TypeFlags.Enum) {
      if (type.isUnionType()) {
        return this.serializeUnion(type, depth, options);
      }
      if (type.isLiteralType()) {
        return JSON.stringify(type.value);
      }
      return "string";
    }

    if (type.isUnionType()) {
      return this.serializeUnion(type, depth, options);
    }

    if (type.isIntersectionType()) {
      return this.serializeIntersection(type, depth, options);
    }

    if (flags & (TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) {
      return "string";
    }

    if (type.isTypeParameter()) {
      const constraint = this.checker.getConstraintOfTypeParameter(type);
      return constraint ? this.serialize(constraint, depth + 1, options) : "unknown";
    }

    if (type.isObjectType()) {
      return this.serializeObjectType(type, depth, options);
    }

    const fallback = this.checker.typeToString(type);
    if (!fallback || fallback.includes("import(")) {
      return "unknown";
    }
    return fallback;
  }

  serializeUnion(type, depth, options) {
    const members = type.getTypes();
    // Simplify true | false -> boolean
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
      const s = this.serialize(m, depth + 1, options);
      if (!seen.has(s)) {
        seen.add(s);
        serialized.push(s);
      }
    }
    if (hasTrue && hasFalse) {
      if (!seen.has("boolean")) {
        seen.add("boolean");
        serialized.push("boolean");
      }
    } else if (hasTrue && !seen.has("true")) {
      serialized.push("true");
    } else if (hasFalse && !seen.has("false")) {
      serialized.push("false");
    }
    if (serialized.length === 0) return "never";
    if (serialized.length === 1) return serialized[0];
    // Collapse Prisma JsonValue expanded union when JsonValue or JsonObject + JsonValue[] appear together
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

  serializeIntersection(type, depth, options) {
    const members = type.getTypes();
    const parts = members.map((m) => {
      const s = this.serialize(m, depth + 1, options);
      return s.includes("|") ? `(${s})` : s;
    });
    return Array.from(new Set(parts)).join(" & ");
  }

  serializeObjectType(type, depth, options) {
    const symbol = type.getSymbol();
    const aliasSymbol = type.getAliasSymbol();
    const symName = symbol?.name ?? "";
    const aliasName = aliasSymbol?.name ?? "";

    // Special well-known wire conversions
    if (symName === "Date") {
      return "string";
    }
    if (symName === "Buffer" || symName === "Uint8Array" || symName === "ArrayBuffer") {
      return "SdkBinaryInput";
    }
    if (
      symName === "Decimal" ||
      aliasName === "Decimal" ||
      symName === "DecimalJsLike"
    ) {
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
    if (symName === "JsonArray" || aliasName === "JsonArray") {
      return "JsonValue[]";
    }
    if (symName === "JsonObject" || aliasName === "JsonObject") {
      return "Record<string, JsonValue>";
    }
    if (symName === "Promise") {
      const args = this.checker.getTypeArguments(type);
      return args[0] ? this.serialize(args[0], depth, options) : "void";
    }
    if (symName === "FastifyReply") {
      return "unknown";
    }

    if (this.checker.isTupleType(type)) {
      const args = this.checker.getTypeArguments(type);
      return `[${args.map((a) => this.serialize(a, depth + 1, options)).join(", ")}]`;
    }

    if (this.checker.isArrayType(type) || symName === "Array" || symName === "ReadonlyArray") {
      const args = this.checker.getTypeArguments(type);
      const elemType = args[0] ? this.serialize(args[0], depth + 1, options) : "unknown";
      const wrapped = elemType.includes("|") || elemType.includes("&") ? `(${elemType})` : elemType;
      return `${wrapped}[]`;
    }

    if (symName === "Record" || aliasName === "Record") {
      const typeArgs =
        type.getAliasTypeArguments().length > 0
          ? type.getAliasTypeArguments()
          : this.checker.getTypeArguments(type);
      if (typeArgs.length >= 2) {
        const keyT = this.serialize(typeArgs[0], depth + 1, options);
        const valT = this.serialize(typeArgs[1], depth + 1, options);
        return `Record<${keyT}, ${valT}>`;
      }
    }

    if (type.id && this.activeTypeIds.has(type.id)) {
      return "JsonValue";
    }

    if (type.id) {
      this.activeTypeIds.add(type.id);
    }

    try {
      const props = this.checker.getPropertiesOfType(type);
      const indexInfos = this.checker.getIndexInfosOfType(type);

      if (props.length === 0 && indexInfos.length === 0) {
        // Check if it's an empty object or branded string/etc.
        if (type.objectFlags & ObjectFlags.Mapped) {
          return "Record<string, unknown>";
        }
        return "Record<string, never>";
      }

      // Detect array-like interfaces (such as Prisma JsonArray / ReadonlyArray clones)
      const propNames = new Set(props.map((p) => p.name));
      if (
        propNames.has("length") &&
        propNames.has("push") &&
        propNames.has("pop") &&
        propNames.has("map")
      ) {
        const numIdx = indexInfos.find(
          (info) => this.serialize(info.keyType, depth + 1, options) === "number",
        );
        const elemStr = numIdx
          ? this.serialize(numIdx.valueType, depth + 1, options)
          : "JsonValue";
        const wrapped =
          elemStr.includes("|") || elemStr.includes("&") ? `(${elemStr})` : elemStr;
        return `${wrapped}[]`;
      }

      const lines = [];
      const extraIndexIntersections = [];
      for (const prop of props) {
        if (prop.name.startsWith("__@")) {
          continue;
        }
        const isOptional = Boolean(prop.flags & SymbolFlags.Optional);
        const propType =
          this.checker.getTypeOfSymbol(prop) ??
          (symbol
            ? this.checker.getTypeOfSymbol(prop)
            : undefined);

        let typeStr = this.serialize(propType, depth + 1, options);
        if (isOptional) {
          typeStr = stripTrailingUndefined(typeStr);
        }
        lines.push(`${quotePropName(prop.name)}${isOptional ? "?" : ""}: ${typeStr};`);
      }

      for (const info of indexInfos) {
        const keyStr = this.serialize(info.keyType, depth + 1, options);
        const valStr = this.serialize(info.valueType, depth + 1, options);
        if (keyStr === "string" || keyStr === "number" || keyStr === "symbol") {
          lines.push(`[key: ${keyStr}]: ${valStr};`);
        } else {
          extraIndexIntersections.push(`Record<${keyStr}, ${valStr}>`);
        }
      }

      if (lines.length === 0 && extraIndexIntersections.length === 0) {
        return "Record<string, unknown>";
      }

      if (lines.length === 0) {
        return extraIndexIntersections.join(" & ");
      }

      const objText = `{ ${lines.join(" ")} }`;
      if (extraIndexIntersections.length > 0) {
        return `${objText} & ${extraIndexIntersections.join(" & ")}`;
      }
      return objText;
    } finally {
      if (type.id) {
        this.activeTypeIds.delete(type.id);
      }
    }
  }

  /**
   * Serializes a Zod schema type by combining `_zod.input` (for input optionality & transforms)
   * with `_zod.output` (to resolve `unknown` on `z.coerce.*` schemas).
   */
  serializeZodSchema(zodSchemaType) {
    const zodProp = this.checker.getPropertyOfType(zodSchemaType, "_zod");
    if (!zodProp) {
      return this.serialize(zodSchemaType, 0);
    }
    const zodInternal = this.checker.getTypeOfSymbol(zodProp);
    const inputProp = this.checker.getPropertyOfType(zodInternal, "input");
    const outputProp = this.checker.getPropertyOfType(zodInternal, "output");
    const inputType = inputProp ? this.checker.getTypeOfSymbol(inputProp) : undefined;
    const outputType = outputProp ? this.checker.getTypeOfSymbol(outputProp) : undefined;

    if (!inputType) {
      return outputType ? this.serialize(outputType, 0) : "Record<string, unknown>";
    }

    return this.mergeZodInputOutput(inputType, outputType, 0);
  }

  mergeZodInputOutput(inputType, outputType, depth) {
    if (depth > 8) return "JsonValue";

    // Handle z.coerce.* where inputType is `unknown` and outputType is `number | boolean | string`
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
          const outPropType = outPropSym
            ? this.checker.getTypeOfSymbol(outPropSym)
            : undefined;
          let propStr = inPropType
            ? this.mergeZodInputOutput(inPropType, outPropType, depth + 1)
            : "unknown";
          if (isOptional) {
            propStr = stripTrailingUndefined(propStr);
          }
          lines.push(`${quotePropName(prop.name)}${isOptional ? "?" : ""}: ${propStr};`);
        }

        const extraIndexIntersections = [];
        for (const info of indexInfos) {
          const outInfo = this.checker.getIndexInfosOfType(outputType)[0];
          const keyStr = this.serialize(info.keyType, depth + 1);
          const valStr = this.mergeZodInputOutput(
            info.valueType,
            outInfo?.valueType,
            depth + 1,
          );
          if (keyStr === "string" || keyStr === "number" || keyStr === "symbol") {
            lines.push(`[key: ${keyStr}]: ${valStr};`);
          } else {
            extraIndexIntersections.push(`Record<${keyStr}, ${valStr}>`);
          }
        }

        if (lines.length === 0 && extraIndexIntersections.length > 0) {
          return extraIndexIntersections.join(" & ");
        }
        const objText = `{ ${lines.join(" ")} }`;
        if (extraIndexIntersections.length > 0) {
          return `${objText} & ${extraIndexIntersections.join(" & ")}`;
        }
        return objText;
      }
    }

    if (inputType.isUnionType()) {
      // Check if input is `unknown | undefined` from optional coerce!
      const members = inputType.getTypes();
      if (
        members.some((m) => m.flags & TypeFlags.Unknown) &&
        outputType
      ) {
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

function stripTrailingUndefined(typeStr) {
  if (typeStr === "undefined") return "undefined";
  const parts = splitTopLevelUnion(typeStr).filter((p) => p !== "undefined");
  if (parts.length === 0) return "undefined";
  return parts.join(" | ");
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
      if (ch === "\\" && i + 1 < str.length) {
        i++;
      } else if (ch === quote) {
        inString = false;
      }
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

function unwrapPromiseType(type, checker) {
  if (!type) return type;
  if (type.isObjectType() && type.getSymbol()?.name === "Promise") {
    const args = checker.getTypeArguments(type);
    return args[0] ?? type;
  }
  return type;
}

function mapControllerMethodToNamespace(controllerName, fullPath, methodName) {
  // Auth suite splits cleanly under `sdk.auth.*`
  if (controllerName === "MeController") {
    return { namespacePath: ["auth"], sdkMethodName: "me" };
  }
  if (controllerName === "PatController") {
    const map = {
      listAvailableScopes: "listScopes",
      createPat: "create",
      listPats: "list",
      revokePatPost: "revoke",
      revokePatDelete: "delete",
    };
    return {
      namespacePath: ["auth", "pats"],
      sdkMethodName: map[methodName] ?? methodName,
    };
  }
  if (controllerName === "OAuthClientsController") {
    if (fullPath.startsWith("/api/v1/auth/devices")) {
      const map = {
        listDevices: "list",
        updateDevice: "update",
        revokeDevicePost: "revoke",
        revokeDeviceDelete: "delete",
      };
      return {
        namespacePath: ["auth", "devices"],
        sdkMethodName: map[methodName] ?? methodName,
      };
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
    return {
      namespacePath: ["auth", "oauthClients"],
      sdkMethodName: map[methodName] ?? methodName,
    };
  }
  if (controllerName === "OAuthProviderController") {
    return { namespacePath: ["auth", "oauth"], sdkMethodName: methodName };
  }
  if (controllerName === "SsoController") {
    return { namespacePath: ["auth", "sso"], sdkMethodName: methodName };
  }

  // Split multi-prefix controllers cleanly
  if (controllerName === "ReceiptsController") {
    if (fullPath.startsWith("/api/v1/payments")) {
      return { namespacePath: ["payments"], sdkMethodName: methodName };
    }
    return { namespacePath: ["receipts"], sdkMethodName: methodName };
  }
  if (controllerName === "SchedulesLeaveController") {
    if (fullPath.startsWith("/api/v1/holidays")) {
      return { namespacePath: ["holidays"], sdkMethodName: methodName };
    }
    if (fullPath.startsWith("/api/v1/time-off")) {
      return { namespacePath: ["timeOff"], sdkMethodName: methodName };
    }
    return { namespacePath: ["schedules"], sdkMethodName: methodName };
  }

  // Domain controllers
  const directMap = {
    RootController: ["system"],
    HealthController: ["health"],
    ObservabilityController: ["observability"],
    TenantsController: ["tenants"],
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
  };

  const namespacePath = directMap[controllerName] ?? [
    controllerName
      .replace(/Controller$/, "")
      .replace(/^./, (c) => c.toLowerCase()),
  ];

  return { namespacePath, sdkMethodName: methodName };
}

/**
 * Custom strongly-typed input overrides where controller intentionally accepts raw Record<string, unknown>
 * (specifically RFC 6749/8628/7662/7009 OAuth endpoints whose dynamic grant validation lives inside OAuthProviderService).
 */
const OAUTH_BODY_OVERRIDES = {
  "OAuthProviderController.requestDeviceCode": {
    typeName: "OAuthDeviceCodeRequest",
    definition: `export interface OAuthDeviceCodeRequest {
  client_id: string;
  client_secret?: string;
  scope?: string;
  device_type?: "ANDROID" | "POS_TERMINAL" | "PRODUCTION_KIOSK" | "SCANNER" | "SYSTEM_AGENT";
  device_identifier?: string;
  device_name?: string;
  location_id?: string;
}`,
    optional: false,
  },
  "OAuthProviderController.exchangeToken": {
    typeName: "OAuthTokenRequest",
    definition: `export type OAuthTokenRequest =
  | {
      grant_type: "client_credentials";
      client_id?: string;
      client_secret?: string;
      client_assertion_type?: string;
      client_assertion?: string;
      scope?: string;
    }
  | {
      grant_type: "authorization_code";
      code: string;
      redirect_uri: string;
      code_verifier: string;
      client_id?: string;
      client_secret?: string;
      device_identifier?: string;
      device_name?: string;
      device_os_version?: string;
      device_app_version?: string;
    }
  | {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code";
      device_code: string;
      client_id?: string;
      client_secret?: string;
    }
  | {
      grant_type: "refresh_token";
      refresh_token: string;
      client_id?: string;
      client_secret?: string;
    };`,
    optional: false,
  },
  "OAuthProviderController.introspectToken": {
    typeName: "OAuthIntrospectRequest",
    definition: `export interface OAuthIntrospectRequest {
  token: string;
  client_id?: string;
  client_secret?: string;
}`,
    optional: false,
  },
  "OAuthProviderController.revokeToken": {
    typeName: "OAuthRevokeRequest",
    definition: `export interface OAuthRevokeRequest {
  token: string;
  client_id?: string;
  client_secret?: string;
}`,
    optional: false,
  },
};

function canTypeBeOmitted(typeStr) {
  // Check if top-level object has no required properties
  if (!typeStr.startsWith("{") || !typeStr.endsWith("}")) {
    return false;
  }
  const inner = typeStr.slice(1, -1).trim();
  if (!inner) return true;
  // Split top-level semicolon properties
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

  return props.every((p) => {
    if (p.startsWith("[key:")) return true;
    const colonIdx = p.indexOf(":");
    if (colonIdx === -1) return false;
    return p.slice(0, colonIdx).trim().endsWith("?");
  });
}

function main() {
  const api = new API({ cwd: repoRoot });
  const snap = api.updateSnapshot({ openProject: apiTsConfigPath });
  const project = snap.getProject(apiTsConfigPath);
  if (!project) {
    throw new Error(`Unable to load TypeScript project: ${apiTsConfigPath}`);
  }

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

  for (const fileName of controllerFiles) {
    const sf = program.getSourceFile(fileName);
    if (!sf) continue;
    const relFile = relative(repoRoot, fileName).replace(/\\/g, "/");

    for (const stmt of sf.statements) {
      if (!isClassDeclaration(stmt) || !stmt.name) continue;
      const controllerName = stmt.name.text;
      const classDecorators = (stmt.modifiers ?? []).filter(isDecorator);

      let controllerPrefix = null;
      let classRequiresTenant = false;
      let classAllowAnonymous = false;
      let classOptionalAuth = false;
      let classPermissions = undefined;

      for (const dec of classDecorators) {
        const info = getDecoratorNameAndArgs(dec);
        if (!info) continue;
        if (info.name === "Controller") {
          controllerPrefix = getStringLiteralValue(info.args[0]) ?? "";
        } else if (info.name === "RequireActiveTenant") {
          classRequiresTenant = true;
        } else if (info.name === "AllowAnonymous") {
          classAllowAnonymous = true;
        } else if (info.name === "OptionalAuth") {
          classOptionalAuth = true;
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
        let methodRequiresTenant = classRequiresTenant;
        let methodAllowAnonymous = classAllowAnonymous;
        let methodOptionalAuth = classOptionalAuth;
        let methodPermissions = classPermissions;

        for (const dec of methodDecorators) {
          const info = getDecoratorNameAndArgs(dec);
          if (!info) continue;
          if (HTTP_METHOD_DECORATORS.has(info.name)) {
            httpMethod = HTTP_METHOD_DECORATORS.get(info.name);
            methodRoutePath = getStringLiteralValue(info.args[0]) ?? "";
          } else if (info.name === "RequireActiveTenant") {
            methodRequiresTenant = true;
          } else if (info.name === "AllowAnonymous") {
            methodAllowAnonymous = true;
          } else if (info.name === "OptionalAuth") {
            methodOptionalAuth = true;
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
                typeStr: serializer.serialize(pType, 0) || "string",
              });
            } else if (pInfo.name === "Body") {
              bodyParamName = pName;
              bodyParamTypeNode = param.type ?? null;
            } else if (pInfo.name === "Query") {
              const qKey = getStringLiteralValue(pInfo.args[0]);
              if (qKey) {
                const qType = checker.getTypeAtLocation(param.name);
                const isOpt = Boolean(param.questionToken || param.initializer);
                const qTypeStr = stripTrailingUndefined(
                  serializer.serialize(qType, 0) || "string",
                );
                inlineQueryProps.push(
                  `${quotePropName(qKey)}${isOpt ? "?" : ""}: ${qTypeStr};`,
                );
              } else {
                queryParamName = pName;
                queryParamTypeNode = param.type ?? null;
              }
            } else if (pInfo.name === "Res") {
              hasResDecorator = true;
            }
          }
        }

        // Scan method body for Zod schemas (`fooSchema.safeParse(body)` / `.parse(...)`),
        // multipart detection, and text/binary response detection.
        let bodyZodNode = null;
        let queryZodNode = null;
        let bodyFallsBackToEmptyObject = false;
        let queryFallsBackToEmptyObject = false;
        let isMultipart = false;
        let hasRedirect = false;
        let detectedContentType = null;
        let sendsBinaryStream = false;

        if (member.body) {
          walkAst(member.body, (node) => {
            if (isCallExpression(node)) {
              if (isPropertyAccessExpression(node.expression)) {
                const fnName = node.expression.name.text;
                if (fnName === "isMultipart") {
                  isMultipart = true;
                } else if (fnName === "redirect") {
                  hasRedirect = true;
                } else if (fnName === "header" && node.arguments?.length >= 2) {
                  const hName = getStringLiteralValue(node.arguments[0]);
                  const hVal = getStringLiteralValue(node.arguments[1]);
                  if (hName?.toLowerCase() === "content-type" && hVal) {
                    detectedContentType = hVal.toLowerCase();
                  }
                } else if (fnName === "send" && node.arguments?.length >= 1) {
                  const argText = node.arguments[0];
                  if (
                    isPropertyAccessExpression(argText) &&
                    argText.name.text === "body"
                  ) {
                    sendsBinaryStream = true;
                  }
                } else if (
                  (fnName === "safeParse" || fnName === "parse") &&
                  node.arguments?.length >= 1
                ) {
                  const schemaExpr = node.expression.expression;
                  const targetArg = node.arguments[0];
                  const targetText = extractRootIdentifier(targetArg);
                  const hasEmptyFallback = containsNullishCoalescingEmptyObj(targetArg);
                  if (bodyParamName && targetText === bodyParamName && !bodyZodNode) {
                    bodyZodNode = schemaExpr;
                    bodyFallsBackToEmptyObject = hasEmptyFallback;
                  } else if (
                    queryParamName &&
                    targetText === queryParamName &&
                    !queryZodNode
                  ) {
                    queryZodNode = schemaExpr;
                    queryFallsBackToEmptyObject = hasEmptyFallback;
                  } else if (
                    isIdentifier(targetArg) &&
                    targetArg.text === "rawInput" &&
                    controllerName === "OAuthProviderController"
                  ) {
                    // handleAuthorize delegate in OAuthProviderController
                    if (httpMethod === "POST") {
                      bodyZodNode = schemaExpr;
                      bodyFallsBackToEmptyObject = true;
                    } else {
                      queryZodNode = schemaExpr;
                      queryFallsBackToEmptyObject = true;
                    }
                  }
                }
              }
            }
          });
        }

        // Special handling for OAuthProviderController.authorizeGet / authorizePost which delegate to handleAuthorize
        if (
          controllerName === "OAuthProviderController" &&
          (methodName === "authorizeGet" || methodName === "authorizePost")
        ) {
          for (const m2 of stmt.members) {
            if (isMethodDeclaration(m2) && m2.name?.text === "handleAuthorize" && m2.body) {
              walkAst(m2.body, (node) => {
                if (
                  isCallExpression(node) &&
                  isPropertyAccessExpression(node.expression) &&
                  node.expression.name.text === "safeParse"
                ) {
                  if (httpMethod === "GET") {
                    queryZodNode = node.expression.expression;
                    queryFallsBackToEmptyObject = true;
                  } else {
                    bodyZodNode = node.expression.expression;
                    bodyFallsBackToEmptyObject = true;
                  }
                }
                if (
                  isCallExpression(node) &&
                  isPropertyAccessExpression(node.expression) &&
                  node.expression.name.text === "redirect"
                ) {
                  hasRedirect = true;
                }
              });
            }
          }
        }

        // Special handling for SsoController.handleCallback delegating to handleSsoCallback
        if (controllerName === "SsoController" && methodName === "handleCallback") {
          for (const m2 of stmt.members) {
            if (isMethodDeclaration(m2) && m2.name?.text === "handleSsoCallback" && m2.body) {
              walkAst(m2.body, (node) => {
                if (
                  isCallExpression(node) &&
                  isPropertyAccessExpression(node.expression) &&
                  node.expression.name.text === "safeParse"
                ) {
                  queryZodNode = node.expression.expression;
                  queryFallsBackToEmptyObject = true;
                }
                if (
                  isCallExpression(node) &&
                  isPropertyAccessExpression(node.expression) &&
                  node.expression.name.text === "redirect"
                ) {
                  hasRedirect = true;
                }
              });
            }
          }
        }

        // Determine Body Type
        const overrideKey = `${controllerName}.${methodName}`;
        let bodyTypeStr = null;
        let bodyOptional = false;
        let multipartTypeStr = null;

        if (isMultipart) {
          multipartTypeStr = `{
  file: SdkBinaryInput;
  filename?: string;
  mimeType?: string;
  entityType?: "ORGANIZATION" | "ITEM" | "VENDOR_BILL" | "PURCHASE_ORDER" | "GOODS_RECEIPT" | "GOODS_RECEIPT_LINE" | "STOCK_LOT" | "PRODUCTION_BATCH" | "PRODUCTION_OPERATION" | "PRODUCTION_QC_CHECKPOINT" | "SUPPLIER" | "CUSTOMER" | "ORDER" | "SALES_INVOICE" | "PAYMENT_RECEIPT";
  entityId?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
}`;
        } else if (OAUTH_BODY_OVERRIDES[overrideKey]) {
          bodyTypeStr = OAUTH_BODY_OVERRIDES[overrideKey].typeName;
          bodyOptional = OAUTH_BODY_OVERRIDES[overrideKey].optional;
        } else if (bodyZodNode) {
          const zodType = checker.getTypeAtLocation(bodyZodNode);
          bodyTypeStr = serializer.serializeZodSchema(zodType);
          bodyOptional = bodyFallsBackToEmptyObject || canTypeBeOmitted(bodyTypeStr);
        } else if (bodyParamName) {
          if (bodyParamTypeNode) {
            const pType = checker.getTypeFromTypeNode(bodyParamTypeNode);
            bodyTypeStr = serializer.serialize(pType, 0);
          } else {
            bodyTypeStr = "Record<string, unknown>";
          }
          bodyOptional = canTypeBeOmitted(bodyTypeStr);
        }

        // Determine Query Type
        let queryTypeStr = null;
        let queryOptional = true;

        if (inlineQueryProps.length > 0) {
          queryTypeStr = `{ ${inlineQueryProps.join(" ")} }`;
          queryOptional = canTypeBeOmitted(queryTypeStr);
        } else if (queryZodNode) {
          const zodType = checker.getTypeAtLocation(queryZodNode);
          queryTypeStr = serializer.serializeZodSchema(zodType);
          queryOptional = queryFallsBackToEmptyObject || canTypeBeOmitted(queryTypeStr);
        } else if (queryParamName) {
          if (queryParamTypeNode) {
            const qType = checker.getTypeFromTypeNode(queryParamTypeNode);
            queryTypeStr = serializer.serialize(qType, 0);
          } else {
            queryTypeStr = "Record<string, string | number | boolean | undefined>";
          }
          queryOptional = true;
        }

        // Determine Response Kind & Return Type
        let responseKind = "json";
        let returnTypeStr = "unknown";

        if (
          sendsBinaryStream ||
          detectedContentType?.includes("application/pdf") ||
          detectedContentType?.includes("application/octet-stream")
        ) {
          responseKind = "binary";
          returnTypeStr = "SdkBinaryResponse";
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
          const sig = fnType
            ? checker.getSignaturesOfType(fnType, SignatureKind.Call)[0]
            : undefined;
          const rawRet = sig ? checker.getReturnTypeOfSignature(sig) : undefined;
          const awaitedRet = unwrapPromiseType(rawRet, checker);

          if (hasRedirect) {
            responseKind = "redirect_or_json";
            returnTypeStr = awaitedRet
              ? serializer.serialize(awaitedRet, 0)
              : "unknown";
          } else if (hasResDecorator) {
            responseKind = "binary";
            returnTypeStr = "SdkBinaryResponse";
          } else {
            returnTypeStr = awaitedRet
              ? serializer.serialize(awaitedRet, 0)
              : "void";
          }
        }

        const { namespacePath, sdkMethodName } = mapControllerMethodToNamespace(
          controllerName,
          fullPath,
          methodName,
        );

        const baseTypeName = toPascalCase(
          [...namespacePath, sdkMethodName].join("_"),
        );

        endpoints.push({
          controllerName,
          sourceFile: relFile,
          methodName,
          namespacePath,
          sdkMethodName,
          baseTypeName,
          httpMethod,
          fullPath,
          authMode: methodAllowAnonymous
            ? "public"
            : methodOptionalAuth
              ? "optional"
              : methodRequiresTenant
                ? "tenant"
                : "authenticated",
          permissions: methodPermissions,
          pathParams,
          queryTypeStr,
          queryOptional,
          bodyTypeStr,
          bodyOptional,
          multipartTypeStr,
          responseKind,
          returnTypeStr,
        });
      }
    }
  }

  snap.dispose();
  api.close();

  emitGeneratedSdk(endpoints);
  console.log(
    `[scace-sdk] Generated typed SDK from ${controllerFiles.length} controllers (${endpoints.length} endpoints) -> src/generated`,
  );
}

function extractRootIdentifier(node) {
  if (!node) return null;
  if (isIdentifier(node)) return node.text;
  // e.g. `query ?? {}` -> BinaryExpression
  if (node.left && isIdentifier(node.left)) {
    return node.left.text;
  }
  return null;
}

function containsNullishCoalescingEmptyObj(node) {
  if (!node) return false;
  return Boolean(node.left && node.right);
}

function buildUrlTemplateExpression(fullPath, pathParams) {
  if (pathParams.length === 0) {
    return JSON.stringify(fullPath);
  }
  let template = fullPath;
  for (const p of pathParams) {
    template = template.replace(
      new RegExp(`:${p.key}\\b`, "g"),
      `\${encodeURIComponent(${p.argName})}`,
    );
  }
  return `\`${template}\``;
}

function emitGeneratedSdk(endpoints) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Deduplicate baseTypeName if two methods accidentally collide
  const usedBaseNames = new Set();
  for (const ep of endpoints) {
    let candidate = ep.baseTypeName;
    let idx = 2;
    while (usedBaseNames.has(candidate)) {
      candidate = `${ep.baseTypeName}${idx++}`;
    }
    usedBaseNames.add(candidate);
    ep.baseTypeName = candidate;
  }

  // 1. Emit src/generated/types.ts
  const typeChunks = [
    `// This file is auto-generated by packages/sdk/scripts/generate-sdk.mjs.`,
    `// Do not edit manually; run \`pnpm --filter @scace/sdk sdk:generate\` to regenerate.`,
    ``,
    `import type { JsonValue, SdkBinaryInput, SdkBinaryResponse } from "../types.js";`,
    ``,
  ];

  for (const def of Object.values(OAUTH_BODY_OVERRIDES)) {
    typeChunks.push(def.definition);
    typeChunks.push(``);
  }

  for (const ep of endpoints) {
    if (ep.queryTypeStr) {
      ep.queryTypeName = `${ep.baseTypeName}Query`;
      typeChunks.push(`export type ${ep.queryTypeName} = ${ep.queryTypeStr};`);
    }
    if (ep.multipartTypeStr) {
      ep.bodyTypeName = `${ep.baseTypeName}UploadInput`;
      typeChunks.push(`export type ${ep.bodyTypeName} = ${ep.multipartTypeStr};`);
    } else if (ep.bodyTypeStr) {
      if (Object.values(OAUTH_BODY_OVERRIDES).some((d) => d.typeName === ep.bodyTypeStr)) {
        ep.bodyTypeName = ep.bodyTypeStr;
      } else {
        ep.bodyTypeName = `${ep.baseTypeName}Input`;
        typeChunks.push(`export type ${ep.bodyTypeName} = ${ep.bodyTypeStr};`);
      }
    }
    if (ep.returnTypeStr === "SdkBinaryResponse") {
      ep.responseTypeName = "SdkBinaryResponse";
    } else {
      ep.responseTypeName = `${ep.baseTypeName}Response`;
      typeChunks.push(`export type ${ep.responseTypeName} = ${ep.returnTypeStr};`);
    }
    typeChunks.push(``);
  }

  writeFileSync(resolve(outDir, "types.ts"), typeChunks.join("\n"));

  // 2. Emit src/generated/routes.ts
  const routeLines = [
    `// Auto-generated endpoint manifest from Scace API NestJS controllers.`,
    ``,
    `export interface GeneratedEndpointMetadata {`,
    `  namespace: string;`,
    `  methodName: string;`,
    `  httpMethod: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";`,
    `  path: string;`,
    `  authMode: "public" | "optional" | "authenticated" | "tenant";`,
    `  permissions?: Record<string, string[]>;`,
    `  controller: string;`,
    `  sourceFile: string;`,
    `}`,
    ``,
    `export const GENERATED_ENDPOINTS: readonly GeneratedEndpointMetadata[] = [`,
  ];

  for (const ep of endpoints) {
    routeLines.push(`  {`);
    routeLines.push(`    namespace: ${JSON.stringify(ep.namespacePath.join("."))},`);
    routeLines.push(`    methodName: ${JSON.stringify(ep.sdkMethodName)},`);
    routeLines.push(`    httpMethod: ${JSON.stringify(ep.httpMethod)},`);
    routeLines.push(`    path: ${JSON.stringify(ep.fullPath)},`);
    routeLines.push(`    authMode: ${JSON.stringify(ep.authMode)},`);
    if (ep.permissions) {
      routeLines.push(`    permissions: ${JSON.stringify(ep.permissions)},`);
    }
    routeLines.push(`    controller: ${JSON.stringify(ep.controllerName)},`);
    routeLines.push(`    sourceFile: ${JSON.stringify(ep.sourceFile)},`);
    routeLines.push(`  },`);
  }
  routeLines.push(`] as const;`);
  routeLines.push(``);
  writeFileSync(resolve(outDir, "routes.ts"), routeLines.join("\n"));

  // 3. Emit src/generated/namespaces.ts
  // Build nested tree: e.g., auth -> { me, pats: {...}, oauthClients: {...}, ... }
  const tree = {};
  for (const ep of endpoints) {
    let cursor = tree;
    for (const seg of ep.namespacePath) {
      if (!cursor[seg]) {
        cursor[seg] = { __endpoints: [], __children: {} };
      }
      cursor = cursor[seg].__children;
    }
    // Re-walk to attach endpoint at target node
    let target = tree;
    for (let i = 0; i < ep.namespacePath.length; i++) {
      const seg = ep.namespacePath[i];
      if (i === ep.namespacePath.length - 1) {
        target[seg].__endpoints.push(ep);
      } else {
        target = target[seg].__children;
      }
    }
  }

  const importedTypeNames = new Set();
  for (const ep of endpoints) {
    if (ep.queryTypeName) importedTypeNames.add(ep.queryTypeName);
    if (ep.bodyTypeName) importedTypeNames.add(ep.bodyTypeName);
    if (ep.responseTypeName && ep.responseTypeName !== "SdkBinaryResponse") {
      importedTypeNames.add(ep.responseTypeName);
    }
  }

  const nsLines = [
    `// Auto-generated typed API namespaces from Scace API controllers and Zod schemas.`,
    ``,
    `import type { ScaceHttpClient } from "../http-client.js";`,
    `import type { SdkBinaryResponse, SdkRequestOptions } from "../types.js";`,
    `import type {`,
    ...Array.from(importedTypeNames)
      .sort()
      .map((name) => `  ${name},`),
    `} from "./types.js";`,
    ``,
  ];

  // Generate interfaces for each namespace node bottom-up
  const interfaceDefs = [];
  function renderNamespaceInterface(node, pathSegments) {
    const childKeys = Object.keys(node.__children).sort();
    for (const childKey of childKeys) {
      renderNamespaceInterface(node.__children[childKey], [...pathSegments, childKey]);
    }

    const ifaceName = `${toPascalCase(pathSegments.join("_"))}Namespace`;
    const bodyLines = [`export interface ${ifaceName} {`];

    for (const ep of node.__endpoints) {
      const params = [];
      for (const p of ep.pathParams) {
        params.push(`${p.argName}: ${p.typeStr}`);
      }
      if (ep.bodyTypeName) {
        params.push(
          `${ep.multipartTypeStr ? "input" : "body"}${ep.bodyOptional && !ep.multipartTypeStr ? "?" : ""}: ${ep.bodyTypeName}`,
        );
      }
      if (ep.queryTypeName) {
        params.push(`query${ep.queryOptional ? "?" : ""}: ${ep.queryTypeName}`);
      }
      params.push(`options?: SdkRequestOptions`);

      const permText = ep.permissions
        ? ` | Permissions: ${JSON.stringify(ep.permissions)}`
        : "";
      bodyLines.push(
        `  /** \`${ep.httpMethod} ${ep.fullPath}\` (${ep.authMode}${permText}) */`,
      );
      bodyLines.push(
        `  ${ep.sdkMethodName}(${params.join(", ")}): Promise<${ep.responseTypeName}>;`,
      );
    }

    for (const childKey of childKeys) {
      const childIface = `${toPascalCase([...pathSegments, childKey].join("_"))}Namespace`;
      bodyLines.push(`  readonly ${childKey}: ${childIface};`);
    }

    bodyLines.push(`}`);
    interfaceDefs.push(bodyLines.join("\n"));
    return ifaceName;
  }

  const rootProps = [];
  for (const topKey of Object.keys(tree).sort()) {
    const ifaceName = renderNamespaceInterface(tree[topKey], [topKey]);
    rootProps.push({ key: topKey, ifaceName });
  }

  nsLines.push(...interfaceDefs);
  nsLines.push(``);
  nsLines.push(`export interface GeneratedSdkNamespaces {`);
  for (const { key, ifaceName } of rootProps) {
    nsLines.push(`  readonly ${key}: ${ifaceName};`);
  }
  nsLines.push(`}`);
  nsLines.push(``);

  function renderNamespaceFactory(node, indent) {
    const lines = [`{`];
    const pad = " ".repeat(indent + 2);

    for (const ep of node.__endpoints) {
      const params = [];
      for (const p of ep.pathParams) {
        params.push(p.argName);
      }
      if (ep.bodyTypeName) {
        params.push(ep.multipartTypeStr ? "input" : "body");
      }
      if (ep.queryTypeName) {
        params.push("query");
      }
      params.push("options");

      const urlExpr = buildUrlTemplateExpression(ep.fullPath, ep.pathParams);
      const reqParts = [
        `method: ${JSON.stringify(ep.httpMethod)}`,
        `path: ${urlExpr}`,
      ];
      if (ep.queryTypeName) {
        reqParts.push(`query`);
      }
      if (ep.multipartTypeStr) {
        reqParts.push(
          `multipart: { file: input.file, filename: input.filename, mimeType: input.mimeType, fields: { entityType: input.entityType, entityId: input.entityId, tags: input.tags, metadata: input.metadata } }`,
        );
      } else if (ep.bodyTypeName) {
        reqParts.push(`body`);
      }
      if (ep.responseKind !== "json") {
        reqParts.push(`responseKind: ${JSON.stringify(ep.responseKind)}`);
      }
      if (ep.authMode === "public") {
        reqParts.push(`skipAuth: true`);
      }
      reqParts.push(`options`);

      lines.push(
        `${pad}${ep.sdkMethodName}: (${params.join(", ")}) => http.request<${ep.responseTypeName}>({ ${reqParts.join(", ")} }),`,
      );
    }

    for (const childKey of Object.keys(node.__children).sort()) {
      lines.push(
        `${pad}${childKey}: ${renderNamespaceFactory(node.__children[childKey], indent + 2)},`,
      );
    }

    lines.push(`${" ".repeat(indent)}}`);
    return lines.join("\n");
  }

  nsLines.push(
    `export function createGeneratedNamespaces(http: ScaceHttpClient): GeneratedSdkNamespaces {`,
  );
  nsLines.push(`  return {`);
  for (const { key } of rootProps) {
    nsLines.push(
      `    ${key}: ${renderNamespaceFactory(tree[key], 4)},`,
    );
  }
  nsLines.push(`  };`);
  nsLines.push(`}`);
  nsLines.push(``);

  writeFileSync(resolve(outDir, "namespaces.ts"), nsLines.join("\n"));

  // 4. Emit src/generated/index.ts
  writeFileSync(
    resolve(outDir, "index.ts"),
    [
      `export * from "./types.js";`,
      `export * from "./routes.js";`,
      `export * from "./namespaces.js";`,
      ``,
    ].join("\n"),
  );
}

main();
