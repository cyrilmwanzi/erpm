import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { OrganizationContext } from "@scace/db";
import { Observable } from "rxjs";
import type { OrganizationScopedRequest } from "./organization.decorators.js";

@Injectable()
export class OrganizationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<OrganizationScopedRequest>();
    const organizationId = request.organization?.organizationId;

    if (!organizationId) {
      throw new ForbiddenException("Active organization context is missing.");
    }

    return new Observable((subscriber) => {
      let innerSub: { unsubscribe: () => void } | undefined;

      OrganizationContext.run(organizationId, () => {
        innerSub = next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      });

      return () => {
        innerSub?.unsubscribe();
      };
    });
  }
}
