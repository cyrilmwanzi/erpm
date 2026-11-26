import { Module } from "@nestjs/common";
import { CommunicationOutboxService } from "./communication-outbox.service.js";
import { CommunicationsController } from "./communications.controller.js";

@Module({
  controllers: [CommunicationsController],
  providers: [CommunicationOutboxService],
  exports: [CommunicationOutboxService],
})
export class CommunicationsModule {}
