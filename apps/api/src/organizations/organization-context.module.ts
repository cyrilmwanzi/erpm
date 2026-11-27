import { Global, Module } from "@nestjs/common";
import { OrganizationGuard } from "./organization.guard.js";
import { OrganizationInterceptor } from "./organization.interceptor.js";

@Global()
@Module({
  providers: [OrganizationGuard, OrganizationInterceptor],
  exports: [OrganizationGuard, OrganizationInterceptor],
})
export class OrganizationContextModule {}
