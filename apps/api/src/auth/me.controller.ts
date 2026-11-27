import { Controller, Get, Inject, Req, UnauthorizedException } from "@nestjs/common";
import { PlatformRole } from "@scace/db";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import type { OrganizationScopedRequest } from "../organizations/organization.decorators.js";

@Controller("api/v1/me")
export class MeController {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  @Get()
  async getProfile(@Req() req: OrganizationScopedRequest) {
    const userSession = req.session;
    if (!userSession?.user?.id) {
      throw new UnauthorizedException("Authentication required.");
    }

    const authContext = req.authContext;
    if (authContext?.isServicePrincipal && authContext.organizationId) {
      const org = await this.prismaService.raw.organization.findUnique({
        where: { id: authContext.organizationId },
        select: { id: true, name: true, slug: true, logo: true },
      });
      return {
        user: {
          ...userSession.user,
          platformRole: PlatformRole.USER,
          isSystemAdmin: false,
        },
        activeOrganizationId: authContext.organizationId,
        authContext,
        organizations: org
          ? [
              {
                memberId: `service:${authContext.oauthClientId ?? authContext.clientId}`,
                role: authContext.serviceRole ?? "member",
                ...org,
              },
            ]
          : [],
      };
    }

    const [dbUser, memberships] = await Promise.all([
      this.prismaService.raw.user.findUnique({
        where: { id: userSession.user.id },
        select: { platformRole: true, email: true, emailVerified: true },
      }),
      this.prismaService.raw.member.findMany({
        where: { userId: userSession.user.id },
        select: {
          id: true,
          role: true,
          createdAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              slug: true,
              logo: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const env = getEnv();
    const emailLower = (dbUser?.email ?? userSession.user.email).toLowerCase();
    const isAllowlisted = env.SYSTEM_ADMIN_EMAILS.includes(emailLower);
    const effectivePlatformRole =
      isAllowlisted || dbUser?.platformRole === PlatformRole.SYSTEM_ADMIN
        ? PlatformRole.SYSTEM_ADMIN
        : PlatformRole.USER;

    return {
      user: {
        ...userSession.user,
        platformRole: effectivePlatformRole,
        isSystemAdmin:
          effectivePlatformRole === PlatformRole.SYSTEM_ADMIN &&
          (dbUser?.emailVerified ?? userSession.user.emailVerified ?? false),
      },
      activeOrganizationId:
        authContext?.organizationId ??
        userSession.session?.activeOrganizationId ??
        null,
      authContext: authContext ?? null,
      organizations: memberships.map((m) => ({
        memberId: m.id,
        role: m.role,
        ...m.organization,
      })),
    };
  }
}
