import { Module } from "@nestjs/common";
import { CommunicationsModule } from "../communications/communications.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { ReportsController } from "./reports.controller.js";
import { ReportsService } from "./reports.service.js";

@Module({
  imports: [CommunicationsModule, StorageModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
