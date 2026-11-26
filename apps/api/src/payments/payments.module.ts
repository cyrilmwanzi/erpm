import { Module } from "@nestjs/common";
import { MpesaConfigService } from "./mpesa-config.service.js";
import { MpesaDarajaClient } from "./mpesa-daraja.client.js";
import { MpesaPaymentService } from "./mpesa-payment.service.js";
import { MpesaSettlementService } from "./mpesa-settlement.service.js";
import { MpesaWebhookController } from "./mpesa-webhook.controller.js";
import { MpesaController } from "./mpesa.controller.js";

@Module({
  controllers: [MpesaController, MpesaWebhookController],
  providers: [
    MpesaDarajaClient,
    MpesaConfigService,
    MpesaSettlementService,
    MpesaPaymentService,
  ],
  exports: [
    MpesaDarajaClient,
    MpesaConfigService,
    MpesaPaymentService,
    MpesaSettlementService,
  ],
})
export class PaymentsModule {}
