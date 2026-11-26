import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { PlatformRole } from "@scace/db";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import type { SystemAdminRequest } from "./billing.decorators.js";

@Injectable()
export class SystemAdminGuard implements CanActivate {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SystemAdminRequest>();
    const session = request.session;
    const authContext = request.authContext;

    if (!session?.user?.id) {
      throw new UnauthorizedException("Authentication required.");
    }

    if (authContext?.isServicePrincipal) {
      throw new ForbiddenException(
        "System administrator endpoints require a human user account.",
      );
    }

    const dbUser = await this.prismaService.raw.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerified: true,
        platformRole: true,
      },
    });

    if (!dbUser) {
      throw new UnauthorizedException("Authenticated user account was not found.");
    }

    if (!dbUser.emailVerified) {
      throw new ForbiddenException(
        "Email verification is required for system administrator access.",
      );
    }

    const env = getEnv();
    const isAllowlisted = env.SYSTEM_ADMIN_EMAILS.includes(
      dbUser.email.trim().toLowerCase(),
    );

    let effectiveRole = dbUser.platformRole;
    if (isAllowlisted && dbUser.platformRole !== PlatformRole.SYSTEM_ADMIN) {
      await this.prismaService.raw.user.update({
        where: { id: dbUser.id },
        data: { platformRole: PlatformRole.SYSTEM_ADMIN },
      });
      effectiveRole = PlatformRole.SYSTEM_ADMIN;
    }

    if (effectiveRole !== PlatformRole.SYSTEM_ADMIN) {
      throw new ForbiddenException(
        "System administrator privileges are required for this endpoint.",
      );
    }

    request.systemAdmin = {
      userId: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      platformRole: effectiveRole,
    };

    return true;
  }
}
