import { Module } from "@nestjs/common";
import { CommunicationsModule } from "../communications/communications.module.js";
import { ExpiryController } from "./expiry.controller.js";
import { ExpiryService } from "./expiry.service.js";

@Module({
  imports: [CommunicationsModule],
  controllers: [ExpiryController],
  providers: [ExpiryService],
  exports: [ExpiryService],
})
export class ExpiryModule {}
