import { Global, Module } from "@nestjs/common";
import { PaymentsModule } from "../payments/payments.module.js";
import { BillingBootstrapService } from "./billing-bootstrap.service.js";
import { BillingEnforcementService } from "./billing-enforcement.service.js";
import { OrgBillingController } from "./org-billing.controller.js";
import { OrgBillingService } from "./org-billing.service.js";
import { PlatformMpesaWebhookController } from "./platform-mpesa-webhook.controller.js";
import { PlatformMpesaService } from "./platform-mpesa.service.js";
import { SystemAdminGuard } from "./system-admin.guard.js";
import { SystemBillingController } from "./system-billing.controller.js";
import { SystemBillingService } from "./system-billing.service.js";

@Global()
@Module({
  imports: [PaymentsModule],
  controllers: [
    SystemBillingController,
    OrgBillingController,
    PlatformMpesaWebhookController,
  ],
  providers: [
    BillingBootstrapService,
    BillingEnforcementService,
    PlatformMpesaService,
    SystemBillingService,
    OrgBillingService,
    SystemAdminGuard,
  ],
  exports: [
    BillingBootstrapService,
    BillingEnforcementService,
    PlatformMpesaService,
    SystemBillingService,
    OrgBillingService,
    SystemAdminGuard,
  ],
})
export class BillingModule {}
