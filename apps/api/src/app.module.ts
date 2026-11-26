import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { SentryModule } from "@sentry/nestjs/setup";
import { AuthModule } from "@thallesp/nestjs-better-auth";
import { auth } from "./auth/auth.config.js";
import { EnterpriseAuthModule } from "./auth/enterprise-auth.module.js";
import { MeController } from "./auth/me.controller.js";
import { UnifiedAuthGuard } from "./auth/unified-auth.guard.js";
import { BillingModule } from "./billing/billing.module.js";
import { CommunicationsModule } from "./communications/communications.module.js";
import { CrmModule } from "./crm/crm.module.js";
import { CustomersModule } from "./customers/customers.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { EmailModule } from "./email/email.module.js";
import { ExpiryModule } from "./expiry/expiry.module.js";
import { FulfillmentsModule } from "./fulfillments/fulfillments.module.js";
import { HealthModule } from "./health/health.module.js";
import { ItemsModule } from "./items/items.module.js";
import { LocationsModule } from "./locations/locations.module.js";
import { EnterpriseExceptionFilter } from "./observability/enterprise-exception.filter.js";
import { ObservabilityInterceptor } from "./observability/observability.interceptor.js";
import { ObservabilityModule } from "./observability/observability.module.js";
import { OrdersModule } from "./orders/orders.module.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { PricingModule } from "./pricing/pricing.module.js";
import { ProcurementModule } from "./procurement/procurement.module.js";
import { ProductionModule } from "./production/production.module.js";
import { RedisModule } from "./redis/redis.module.js";
import { ReportsModule } from "./reports/reports.module.js";
import { StaffModule } from "./staff/staff.module.js";
import { StorageModule } from "./storage/storage.module.js";
import { TenancyModule } from "./tenancy/tenancy.module.js";
import { TenantsModule } from "./tenants/tenants.module.js";
import { VariantsModule } from "./variants/variants.module.js";

@Module({
  imports: [
    SentryModule.forRoot(),
    ObservabilityModule,
    DatabaseModule,
    RedisModule,
    StorageModule,
    EmailModule,
    TenancyModule,
    BillingModule,
    AuthModule.forRoot({
      auth,
      isGlobal: true,
      disableGlobalAuthGuard: true,
      disableTrustedOriginsCors: true,
      bodyParser: {
        json: { limit: "1mb" },
        urlencoded: { limit: "1mb", extended: true },
        rawBody: true,
      },
    }),
    EnterpriseAuthModule,
    HealthModule,
    TenantsModule,
    ItemsModule,
    VariantsModule,
    LocationsModule,
    ProcurementModule,
    ProductionModule,
    StaffModule,
    CrmModule,
    PricingModule,
    CustomersModule,
    OrdersModule,
    PaymentsModule,
    FulfillmentsModule,
    CommunicationsModule,
    ExpiryModule,
    ReportsModule,
  ],
  controllers: [MeController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: UnifiedAuthGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ObservabilityInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: EnterpriseExceptionFilter,
    },
  ],
})
export class AppModule {}
