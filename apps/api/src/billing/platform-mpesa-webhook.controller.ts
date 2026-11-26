import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { PlatformMpesaService } from "./platform-mpesa.service.js";

const platformStkCallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string().trim().min(1),
      CheckoutRequestID: z.string().trim().min(1),
      ResultCode: z.coerce.number().int(),
      ResultDesc: z.string(),
      CallbackMetadata: z
        .object({
          Item: z
            .array(
              z.object({
                Name: z.string(),
                Value: z.union([z.string(), z.number(), z.null()]).optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    }),
  }),
});

@Controller("api/v1/webhooks/platform-daraja/:platformToken")
@AllowAnonymous()
export class PlatformMpesaWebhookController {
  constructor(
    @Inject(PlatformMpesaService)
    private readonly platformMpesaService: PlatformMpesaService,
  ) {}

  @Post("stk/:txToken")
  @HttpCode(200)
  async handleStkCallback(
    @Param("platformToken") platformToken: string,
    @Param("txToken") txToken: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = platformStkCallbackSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid platform Daraja STK callback payload.",
        issues: parsed.error.issues,
      });
    }

    return this.platformMpesaService.handleStkCallback({
      platformToken,
      txToken,
      payload: parsed.data,
      clientIp: req.ip,
    });
  }
}
