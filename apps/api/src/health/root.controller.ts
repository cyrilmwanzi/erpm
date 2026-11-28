import { Controller, Get } from "@nestjs/common";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";

@Controller()
export class RootController {
  @Get()
  @AllowAnonymous()
  getServiceInfo() {
    return {
      service: "Scace API",
      status: "ok",
      endpoints: {
        health: "/api/v1/health",
        auth: "/api/auth/ok",
        me: "/api/v1/me",
        organizationCurrent: "/api/v1/organizations/current",
        organizationPermissions: "/api/v1/organizations/permissions",
        organizationSettings: "/api/v1/organizations/settings",
        organizationMembers: "/api/v1/organizations/members",
        organizationInvitations: "/api/v1/organizations/invitations",
        organizationAuditLogs: "/api/v1/organizations/audit-logs",
        items: "/api/v1/items",
        locations: "/api/v1/locations",
        inventory: "/api/v1/inventory",
        suppliers: "/api/v1/suppliers",
        purchaseOrders: "/api/v1/purchase-orders",
        deliveries: "/api/v1/deliveries",
        production: "/api/v1/production",
        vendorBills: "/api/v1/vendor-bills",
        storage: "/api/v1/storage",
        departments: "/api/v1/departments",
        staff: "/api/v1/staff",
        teams: "/api/v1/teams",
        schedules: "/api/v1/schedules",
        holidays: "/api/v1/holidays",
        timeOff: "/api/v1/time-off",
        availability: "/api/v1/availability",
        calendar: "/api/v1/calendar",
        crm: "/api/v1/crm",
        pricing: "/api/v1/pricing",
        customers: "/api/v1/customers",
        orders: "/api/v1/orders",
        invoices: "/api/v1/invoices",
        payments: "/api/v1/payments",
        receipts: "/api/v1/receipts",
        fulfillments: "/api/v1/fulfillments",
        staffJobs: "/api/v1/staff-jobs",
        openidConfiguration: "/.well-known/openid-configuration",
        oauthAuthorizationServer: "/.well-known/oauth-authorization-server",
        oauthProtectedResource: "/.well-known/oauth-protected-resource",
        jwks: "/.well-known/jwks.json",
        oauthAuthorize: "/api/v1/oauth/authorize",
        oauthToken: "/api/v1/oauth/token",
        oauthDeviceCode: "/api/v1/oauth/device/code",
        oauthDeviceVerify: "/api/v1/oauth/device/verify",
        oauthIntrospect: "/api/v1/oauth/introspect",
        oauthRevoke: "/api/v1/oauth/revoke",
        pats: "/api/v1/auth/pats",
        oauthClients: "/api/v1/auth/oauth-clients",
        devices: "/api/v1/auth/devices",
        ssoProviders: "/api/v1/auth/sso/providers",
        ssoConfig: "/api/v1/auth/sso/config",
      },
    };
  }
}
