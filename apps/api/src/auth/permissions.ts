import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

export const erpStatements = {
  ...defaultStatements,
  organizationSettings: ["read", "update"],
  auditLog: ["read"],
  erpWorkspace: ["read", "create", "update", "delete"],
  item: ["read", "create", "update", "archive"],
  location: ["read", "create", "update", "archive"],
  inventory: ["read", "adjust", "transfer", "manageExpiry", "writeOff"],
  supplier: ["read", "create", "update", "archive"],
  purchaseOrder: ["read", "create", "update", "submit", "receive", "qc", "accept", "cancel"],
  vendorBill: ["read", "create", "update", "pay", "void"],
  storage: ["read", "upload", "delete", "manage"],
  staff: ["read", "create", "update", "archive", "selfUpdate"],
  department: ["read", "create", "update", "archive"],
  team: ["read", "create", "update", "archive"],
  timeOff: ["read", "request", "approve"],
  calendar: ["read", "manage"],
  crm: ["read", "create", "update", "delete", "configure"],
  pricing: ["read", "create", "update", "archive", "quote"],
  customer: ["read", "create", "update", "archive"],
  order: ["read", "create", "update", "confirm", "fulfill", "posCheckout", "cancel"],
  invoice: ["read", "create", "issue", "void"],
  payment: ["read", "record", "void", "configure", "reconcile"],
  receipt: ["read"],
  fulfillment: ["read", "create", "update", "confirm", "complete", "cancel", "configure"],
  staffJob: ["read", "create", "assign", "update", "complete", "cancel"],
  notification: ["read", "send", "configureTemplates"],
  apiToken: ["read", "create", "revoke"],
  oauthClient: ["read", "create", "update", "revoke", "manageKeys"],
  device: ["read", "approve", "update", "revoke"],
  ssoConfig: ["read", "configure"],
  production: ["read", "create", "update", "release", "schedule", "consume", "qc", "costing", "complete", "cancel"],
  report: ["read", "export", "schedule"],
  communication: ["read", "manage", "dispatch"],
  billing: ["read", "manage"],
} as const;

export type ErpStatements = typeof erpStatements;
export type ErpResource = keyof ErpStatements;
export type OrgPermissionRequirement = {
  [K in ErpResource]?: readonly ErpStatements[K][number][];
};

export const ac = createAccessControl(erpStatements);

export const owner = ac.newRole({
  ...ownerAc.statements,
  organizationSettings: ["read", "update"],
  auditLog: ["read"],
  erpWorkspace: ["read", "create", "update", "delete"],
  item: ["read", "create", "update", "archive"],
  location: ["read", "create", "update", "archive"],
  inventory: ["read", "adjust", "transfer", "manageExpiry", "writeOff"],
  supplier: ["read", "create", "update", "archive"],
  purchaseOrder: ["read", "create", "update", "submit", "receive", "qc", "accept", "cancel"],
  vendorBill: ["read", "create", "update", "pay", "void"],
  storage: ["read", "upload", "delete", "manage"],
  staff: ["read", "create", "update", "archive", "selfUpdate"],
  department: ["read", "create", "update", "archive"],
  team: ["read", "create", "update", "archive"],
  timeOff: ["read", "request", "approve"],
  calendar: ["read", "manage"],
  crm: ["read", "create", "update", "delete", "configure"],
  pricing: ["read", "create", "update", "archive", "quote"],
  customer: ["read", "create", "update", "archive"],
  order: ["read", "create", "update", "confirm", "fulfill", "posCheckout", "cancel"],
  invoice: ["read", "create", "issue", "void"],
  payment: ["read", "record", "void", "configure", "reconcile"],
  receipt: ["read"],
  fulfillment: ["read", "create", "update", "confirm", "complete", "cancel", "configure"],
  staffJob: ["read", "create", "assign", "update", "complete", "cancel"],
  notification: ["read", "send", "configureTemplates"],
  apiToken: ["read", "create", "revoke"],
  oauthClient: ["read", "create", "update", "revoke", "manageKeys"],
  device: ["read", "approve", "update", "revoke"],
  ssoConfig: ["read", "configure"],
  production: ["read", "create", "update", "release", "schedule", "consume", "qc", "costing", "complete", "cancel"],
  report: ["read", "export", "schedule"],
  communication: ["read", "manage", "dispatch"],
  billing: ["read", "manage"],
});

export const admin = ac.newRole({
  ...adminAc.statements,
  organizationSettings: ["read", "update"],
  auditLog: ["read"],
  erpWorkspace: ["read", "create", "update", "delete"],
  item: ["read", "create", "update", "archive"],
  location: ["read", "create", "update", "archive"],
  inventory: ["read", "adjust", "transfer", "manageExpiry", "writeOff"],
  supplier: ["read", "create", "update", "archive"],
  purchaseOrder: ["read", "create", "update", "submit", "receive", "qc", "accept", "cancel"],
  vendorBill: ["read", "create", "update", "pay", "void"],
  storage: ["read", "upload", "delete", "manage"],
  staff: ["read", "create", "update", "archive", "selfUpdate"],
  department: ["read", "create", "update", "archive"],
  team: ["read", "create", "update", "archive"],
  timeOff: ["read", "request", "approve"],
  calendar: ["read", "manage"],
  crm: ["read", "create", "update", "delete", "configure"],
  pricing: ["read", "create", "update", "archive", "quote"],
  customer: ["read", "create", "update", "archive"],
  order: ["read", "create", "update", "confirm", "fulfill", "posCheckout", "cancel"],
  invoice: ["read", "create", "issue", "void"],
  payment: ["read", "record", "void", "configure", "reconcile"],
  receipt: ["read"],
  fulfillment: ["read", "create", "update", "confirm", "complete", "cancel", "configure"],
  staffJob: ["read", "create", "assign", "update", "complete", "cancel"],
  notification: ["read", "send", "configureTemplates"],
  apiToken: ["read", "create", "revoke"],
  oauthClient: ["read", "create", "update", "revoke", "manageKeys"],
  device: ["read", "approve", "update", "revoke"],
  ssoConfig: ["read", "configure"],
  production: ["read", "create", "update", "release", "schedule", "consume", "qc", "costing", "complete", "cancel"],
  report: ["read", "export", "schedule"],
  communication: ["read", "manage", "dispatch"],
  billing: ["read", "manage"],
});

export const manager = ac.newRole({
  organization: [],
  member: ["create", "update"],
  invitation: ["create", "cancel"],
  team: ["read", "create", "update", "archive"],
  ac: ["read"],
  organizationSettings: ["read"],
  auditLog: ["read"],
  erpWorkspace: ["read", "create", "update"],
  item: ["read", "create", "update", "archive"],
  location: ["read", "create", "update", "archive"],
  inventory: ["read", "adjust", "transfer", "manageExpiry", "writeOff"],
  supplier: ["read", "create", "update", "archive"],
  purchaseOrder: ["read", "create", "update", "submit", "receive", "qc", "accept", "cancel"],
  vendorBill: ["read", "create", "update", "pay", "void"],
  storage: ["read", "upload", "delete"],
  staff: ["read", "create", "update", "archive", "selfUpdate"],
  department: ["read", "create", "update", "archive"],
  timeOff: ["read", "request", "approve"],
  calendar: ["read", "manage"],
  crm: ["read", "create", "update", "delete"],
  pricing: ["read", "create", "update", "quote"],
  customer: ["read", "create", "update", "archive"],
  order: ["read", "create", "update", "confirm", "fulfill", "posCheckout", "cancel"],
  invoice: ["read", "create", "issue", "void"],
  payment: ["read", "record", "void", "reconcile"],
  receipt: ["read"],
  fulfillment: ["read", "create", "update", "confirm", "complete", "cancel", "configure"],
  staffJob: ["read", "create", "assign", "update", "complete", "cancel"],
  notification: ["read", "send", "configureTemplates"],
  apiToken: ["read", "create", "revoke"],
  oauthClient: ["read"],
  device: ["read", "approve", "update", "revoke"],
  ssoConfig: [],
  production: ["read", "create", "update", "release", "schedule", "consume", "qc", "costing", "complete", "cancel"],
  report: ["read", "export", "schedule"],
  communication: ["read", "manage", "dispatch"],
  billing: ["read"],
});

export const member = ac.newRole({
  ...memberAc.statements,
  organizationSettings: ["read"],
  erpWorkspace: ["read", "create", "update"],
  item: ["read", "create", "update"],
  location: ["read"],
  inventory: ["read", "adjust", "transfer"],
  supplier: ["read"],
  purchaseOrder: ["read", "create", "update", "receive"],
  vendorBill: ["read", "create"],
  storage: ["read", "upload"],
  staff: ["read", "selfUpdate"],
  department: ["read"],
  team: ["read"],
  timeOff: ["read", "request"],
  calendar: ["read"],
  crm: ["read", "create", "update", "delete"],
  pricing: ["read", "quote"],
  customer: ["read", "create", "update"],
  order: ["read", "create", "update", "confirm", "fulfill", "posCheckout"],
  invoice: ["read", "create", "issue"],
  payment: ["read", "record"],
  receipt: ["read"],
  fulfillment: ["read", "create", "update", "confirm", "complete"],
  staffJob: ["read", "create", "update", "complete"],
  notification: ["read", "send"],
  apiToken: ["read", "create", "revoke"],
  oauthClient: [],
  device: ["read", "revoke"],
  ssoConfig: [],
  production: ["read", "create", "update", "consume", "complete"],
  report: ["read", "export"],
  communication: ["read"],
  billing: ["read"],
});

export const viewer = ac.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: ["read"],
  ac: ["read"],
  organizationSettings: ["read"],
  erpWorkspace: ["read"],
  item: ["read"],
  location: ["read"],
  inventory: ["read"],
  supplier: ["read"],
  purchaseOrder: ["read"],
  vendorBill: ["read"],
  storage: ["read"],
  staff: ["read"],
  department: ["read"],
  timeOff: ["read"],
  calendar: ["read"],
  crm: ["read"],
  pricing: ["read"],
  customer: ["read"],
  order: ["read"],
  invoice: ["read"],
  payment: ["read"],
  receipt: ["read"],
  fulfillment: ["read"],
  staffJob: ["read"],
  notification: ["read"],
  apiToken: [],
  oauthClient: [],
  device: [],
  ssoConfig: [],
  production: ["read"],
  report: ["read"],
  communication: [],
  billing: [],
});

export const organizationRoles = {
  owner,
  admin,
  manager,
  member,
  viewer,
} as const;

export type OrganizationRoleName = keyof typeof organizationRoles;

export const ORGANIZATION_ROLE_NAMES = Object.keys(
  organizationRoles,
) as OrganizationRoleName[];

export const STANDARD_OIDC_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
] as const;

export const ALL_ERP_SCOPES: readonly string[] = Object.entries(erpStatements).flatMap(
  ([resource, actions]) => actions.map((action) => `${resource}:${action}`),
);

export const ALL_SUPPORTED_OAUTH_SCOPES: readonly string[] = [
  ...STANDARD_OIDC_SCOPES,
  ...ALL_ERP_SCOPES,
];

const SUPPORTED_SCOPE_SET = new Set<string>(ALL_SUPPORTED_OAUTH_SCOPES);
const ERP_SCOPE_SET = new Set<string>(ALL_ERP_SCOPES);

export function isValidErpScope(scope: string): boolean {
  return ERP_SCOPE_SET.has(scope);
}

export function isValidOAuthScope(scope: string): boolean {
  return SUPPORTED_SCOPE_SET.has(scope);
}

export function normalizeScopesInput(input: string | readonly string[]): string[] {
  const rawList = Array.isArray(input)
    ? input
    : String(input)
        .split(/[\s,]+/)
        .map((s) => s.trim());
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of rawList) {
    const trimmed = String(item).trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function isValidOrganizationRole(
  role: string,
): role is OrganizationRoleName {
  return Object.prototype.hasOwnProperty.call(organizationRoles, role);
}

export function parseRoleNames(roleValue: string): OrganizationRoleName[] {
  return roleValue
    .split(",")
    .map((r) => r.trim())
    .filter(isValidOrganizationRole);
}

export function getResolvedPermissionsForRole(
  roleValue: string,
): Record<ErpResource, string[]> {
  const resolved: Record<ErpResource, Set<string>> = {
    organization: new Set(),
    member: new Set(),
    invitation: new Set(),
    team: new Set(),
    ac: new Set(),
    organizationSettings: new Set(),
    auditLog: new Set(),
    erpWorkspace: new Set(),
    item: new Set(),
    location: new Set(),
    inventory: new Set(),
    supplier: new Set(),
    purchaseOrder: new Set(),
    vendorBill: new Set(),
    storage: new Set(),
    staff: new Set(),
    department: new Set(),
    timeOff: new Set(),
    calendar: new Set(),
    crm: new Set(),
    pricing: new Set(),
    customer: new Set(),
    order: new Set(),
    invoice: new Set(),
    payment: new Set(),
    receipt: new Set(),
    fulfillment: new Set(),
    staffJob: new Set(),
    notification: new Set(),
    apiToken: new Set(),
    oauthClient: new Set(),
    device: new Set(),
    ssoConfig: new Set(),
    production: new Set(),
    report: new Set(),
    communication: new Set(),
    billing: new Set(),
  };

  for (const roleName of parseRoleNames(roleNameList(roleValue))) {
    const roleDef = organizationRoles[roleName];
    const statements = roleDef.statements as Partial<
      Record<ErpResource, readonly string[]>
    >;
    for (const resource of Object.keys(statements) as ErpResource[]) {
      const actions = statements[resource] ?? [];
      for (const action of actions) {
        resolved[resource].add(action);
      }
    }
  }

  return {
    organization: Array.from(resolved.organization),
    member: Array.from(resolved.member),
    invitation: Array.from(resolved.invitation),
    team: Array.from(resolved.team),
    ac: Array.from(resolved.ac),
    organizationSettings: Array.from(resolved.organizationSettings),
    auditLog: Array.from(resolved.auditLog),
    erpWorkspace: Array.from(resolved.erpWorkspace),
    item: Array.from(resolved.item),
    location: Array.from(resolved.location),
    inventory: Array.from(resolved.inventory),
    supplier: Array.from(resolved.supplier),
    purchaseOrder: Array.from(resolved.purchaseOrder),
    vendorBill: Array.from(resolved.vendorBill),
    storage: Array.from(resolved.storage),
    staff: Array.from(resolved.staff),
    department: Array.from(resolved.department),
    timeOff: Array.from(resolved.timeOff),
    calendar: Array.from(resolved.calendar),
    crm: Array.from(resolved.crm),
    pricing: Array.from(resolved.pricing),
    customer: Array.from(resolved.customer),
    order: Array.from(resolved.order),
    invoice: Array.from(resolved.invoice),
    payment: Array.from(resolved.payment),
    receipt: Array.from(resolved.receipt),
    fulfillment: Array.from(resolved.fulfillment),
    staffJob: Array.from(resolved.staffJob),
    notification: Array.from(resolved.notification),
    apiToken: Array.from(resolved.apiToken),
    oauthClient: Array.from(resolved.oauthClient),
    device: Array.from(resolved.device),
    ssoConfig: Array.from(resolved.ssoConfig),
    production: Array.from(resolved.production),
    report: Array.from(resolved.report),
    communication: Array.from(resolved.communication),
    billing: Array.from(resolved.billing),
  };
}

function roleNameList(roleValue: string): string {
  return roleValue ?? "";
}

export function intersectPermissionsWithScopes(
  rolePermissions: Record<ErpResource, string[]>,
  grantedScopes: readonly string[],
): Record<ErpResource, string[]> {
  const scopeSet = new Set(grantedScopes);
  const intersected = {} as Record<ErpResource, string[]>;
  for (const resource of Object.keys(rolePermissions) as ErpResource[]) {
    intersected[resource] = (rolePermissions[resource] ?? []).filter((action) =>
      scopeSet.has(`${resource}:${action}`),
    );
  }
  return intersected;
}

export function hasOrganizationPermission(
  roleValue: string,
  required: OrgPermissionRequirement,
  grantedScopes?: readonly string[],
): boolean {
  const roleNames = parseRoleNames(roleValue);
  if (roleNames.length === 0) {
    return false;
  }

  const baseResolved = getResolvedPermissionsForRole(roleValue);
  const effective = grantedScopes
    ? intersectPermissionsWithScopes(baseResolved, grantedScopes)
    : baseResolved;

  for (const [resource, actions] of Object.entries(required) as [
    ErpResource,
    readonly string[] | undefined,
  ][]) {
    if (!actions || actions.length === 0) {
      continue;
    }
    const granted = effective[resource] ?? [];
    const hasAllActions = actions.every((action) => granted.includes(action));
    if (!hasAllActions) {
      return false;
    }
  }

  return true;
}
