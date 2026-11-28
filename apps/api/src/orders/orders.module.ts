import { Module } from "@nestjs/common";
import { CommunicationsModule } from "../communications/communications.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { PricingModule } from "../pricing/pricing.module.js";
import { CreditControlService } from "./credit-control.service.js";
import { CustomerPoController } from "./customer-pos.controller.js";
import { CustomerPoService } from "./customer-pos.service.js";
import { InvoicesController } from "./invoices.controller.js";
import { InvoicesPaymentsService } from "./invoices-payments.service.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";
import { ReceiptsController } from "./receipts.controller.js";

@Module({
  imports: [PricingModule, PaymentsModule, CommunicationsModule],
  controllers: [
    OrdersController,
    InvoicesController,
    ReceiptsController,
    CustomerPoController,
  ],
  providers: [
    OrdersService,
    InvoicesPaymentsService,
    CreditControlService,
    CustomerPoService,
  ],
  exports: [
    OrdersService,
    InvoicesPaymentsService,
    CreditControlService,
    CustomerPoService,
  ],
})
export class OrdersModule {}
