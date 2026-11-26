import { prisma, PlatformRole, type Prisma } from "@scace/db";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { redisStorage } from "@better-auth/redis-storage";
import { betterAuth } from "better-auth";
import { bearer, genericOAuth, organization } from "better-auth/plugins";
import { Redis } from "ioredis";
import { provisionInitialTrialForOrganization } from "../billing/billing-bootstrap.service.js";
import { getEnv } from "../config/env.js";
import { emailDelivery } from "../email/email.service.js";
import { createRedisClientWithFallback, MockRedis } from "../redis/redis-mock.js";
import { deriveOrganizationBucketName } from "../storage/storage.utils.js";
import { ac, organizationRoles } from "./permissions.js";

const env = getEnv();

function createAuthRedisClient(): Redis {
  if (!process.env.REDIS_URL || process.env.REDIS_URL.trim().length === 0) {
    console.warn("[AI Studio] REDIS_URL not configured — using in-memory Redis mock for auth");
    return new MockRedis() as unknown as Redis;
  }

  return createRedisClientWithFallback(
    () =>
      new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 500,
        retryStrategy: () => null,
        enableReadyCheck: false,
        lazyConnect: true,
      }),
    { label: "AuthRedis" },
  );
}

export const authRedisClient: Redis = createAuthRedisClient();

async function invalidateMembershipCache(
  organizationId: string,
  userId: string,
): Promise<void> {
  try {
    if (authRedisClient.status === "wait") {
      await authRedisClient.connect();
    }
    await authRedisClient.del(
      `${env.REDIS_KEY_PREFIX}membership:${organizationId}:${userId}`,
    );
  } catch {
    // Non-fatal if Redis is unavailable during hook execution
  }
}

async function recordOrganizationAudit(params: {
  organizationId: string;
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: params.organizationId,
        actorUserId: params.actorUserId ?? null,
        action: params.action,
        resourceType: params.resourceType,
        resourceId: params.resourceId ?? null,
        metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.warn(
      `[better-auth:audit] Failed to record ${params.action}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

const DEFAULT_WORKING_DAYS: Record<
  string,
  { enabled: boolean; start: string; end: string; breakMinutes: number }
> = {
  monday: { enabled: true, start: "09:00", end: "17:00", breakMinutes: 0 },
  tuesday: { enabled: true, start: "09:00", end: "17:00", breakMinutes: 0 },
  wednesday: { enabled: true, start: "09:00", end: "17:00", breakMinutes: 0 },
  thursday: { enabled: true, start: "09:00", end: "17:00", breakMinutes: 0 },
  friday: { enabled: true, start: "09:00", end: "17:00", breakMinutes: 0 },
  saturday: { enabled: false, start: "09:00", end: "17:00", breakMinutes: 0 },
  sunday: { enabled: false, start: "09:00", end: "17:00", breakMinutes: 0 },
};

function splitDisplayName(name: string, fallbackEmail: string): {
  firstName: string;
  lastName: string;
  displayName: string;
} {
  const cleaned = name.trim();
  if (cleaned.length > 0) {
    const parts = cleaned.split(/\s+/);
    const firstName = parts[0] ?? cleaned;
    const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "-";
    return {
      firstName: firstName.slice(0, 80),
      lastName: lastName.slice(0, 80),
      displayName: cleaned.slice(0, 120),
    };
  }
  const local = fallbackEmail.split("@")[0] || "Staff";
  return {
    firstName: local.slice(0, 80),
    lastName: "-",
    displayName: local.slice(0, 120),
  };
}

async function ensureDefaultWorkScheduleId(
  organizationId: string,
): Promise<string | null> {
  try {
    const existing = await prisma.workSchedule.findFirst({
      where: { organizationId, isDefault: true, isActive: true },
      select: { id: true },
    });
    if (existing?.id) {
      return existing.id;
    }
    const created = await prisma.workSchedule.create({
      data: {
        organizationId,
        name: "Standard 40h Week",
        timezone: "UTC",
        weeklyCapacityMinutes: 2400,
        workingDays: DEFAULT_WORKING_DAYS as Prisma.InputJsonValue,
        isDefault: true,
        isActive: true,
      },
      select: { id: true },
    });
    return created?.id ?? null;
  } catch {
    return null;
  }
}

async function linkOrProvisionStaffForMember(params: {
  organizationId: string;
  memberId?: string | null;
  userId: string;
  email: string;
  name: string;
}): Promise<void> {
  try {
    let resolvedMemberId = params.memberId ?? null;
    if (!resolvedMemberId) {
      const dbMember = await prisma.member.findUnique({
        where: {
          organizationId_userId: {
            organizationId: params.organizationId,
            userId: params.userId,
          },
        },
        select: { id: true },
      });
      resolvedMemberId = dbMember?.id ?? null;
    }
    if (!resolvedMemberId) {
      return;
    }

    const alreadyLinked = await prisma.staffProfile.findFirst({
      where: {
        organizationId: params.organizationId,
        memberId: resolvedMemberId,
      },
      select: { id: true },
    });
    if (alreadyLinked) {
      return;
    }

    const normalizedEmail = params.email.trim().toLowerCase();
    const pendingByEmail = await prisma.staffProfile.findFirst({
      where: {
        organizationId: params.organizationId,
        workEmail: normalizedEmail,
      },
      select: { id: true, status: true, memberId: true },
    });

    if (pendingByEmail) {
      if (!pendingByEmail.memberId) {
        await prisma.staffProfile.update({
          where: { id: pendingByEmail.id },
          data: {
            memberId: resolvedMemberId,
            status:
              pendingByEmail.status === "PREBOARDING"
                ? "ACTIVE"
                : pendingByEmail.status,
          },
        });
      }
      return;
    }

    const defaultScheduleId = await ensureDefaultWorkScheduleId(
      params.organizationId,
    );
    const parsedName = splitDisplayName(params.name, normalizedEmail);

    await prisma.staffProfile.create({
      data: {
        organizationId: params.organizationId,
        memberId: resolvedMemberId,
        firstName: parsedName.firstName,
        lastName: parsedName.lastName,
        displayName: parsedName.displayName,
        workEmail: normalizedEmail,
        workScheduleId: defaultScheduleId,
        status: "ACTIVE",
        timezone: "UTC",
        weeklyCapacityMinutes: 2400,
        createdByUserId: params.userId,
      },
    });
  } catch (err) {
    console.warn(
      `[better-auth:staff] Failed to link staff profile: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

const isHttpsDeployment =
  env.APP_URL.startsWith("https://") ||
  env.BETTER_AUTH_URL.startsWith("https://");

const socialProviders: Record<string, Record<string, unknown>> = {};
if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
  socialProviders.google = {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
  };
}
if (env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET) {
  socialProviders.microsoft = {
    clientId: env.MICROSOFT_OAUTH_CLIENT_ID,
    clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
    tenantId: env.MICROSOFT_OAUTH_TENANT_ID,
  };
}
if (env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET) {
  socialProviders.github = {
    clientId: env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
  };
}

const genericOAuthConfigs: Array<{
  providerId: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
  scopes?: string[];
}> = [];
if (
  env.OIDC_SSO_CLIENT_ID &&
  env.OIDC_SSO_CLIENT_SECRET &&
  env.OIDC_SSO_ISSUER_URL
) {
  genericOAuthConfigs.push({
    providerId: "enterprise-oidc",
    clientId: env.OIDC_SSO_CLIENT_ID,
    clientSecret: env.OIDC_SSO_CLIENT_SECRET,
    discoveryUrl: `${env.OIDC_SSO_ISSUER_URL.replace(/\/+$/, "")}/.well-known/openid-configuration`,
    scopes: ["openid", "profile", "email"],
  });
}

export const auth = betterAuth({
  appName: "Scace",
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.APP_URL || env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  trustedOrigins: Array.from(
    new Set([
      ...env.CORS_ALLOWED_ORIGINS,
      env.APP_URL,
      env.BETTER_AUTH_URL,
    ]),
  ),
  advanced: isHttpsDeployment
    ? {
        useSecureCookies: true,
        defaultCookieAttributes: {
          sameSite: "none",
          secure: true,
          httpOnly: true,
        },
      }
    : undefined,
  ...(Object.keys(socialProviders).length > 0 ? { socialProviders } : {}),
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  secondaryStorage: redisStorage({
    client: authRedisClient,
    keyPrefix: "better-auth:",
  }),
  session: {
    storeSessionInDatabase: true,
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    requireEmailVerification: true,
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
    async sendVerificationEmail({ user, url }) {
      await emailDelivery.sendVerificationEmail({
        to: user.email,
        userName: user.name,
        verificationUrl: url,
      });
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          if (
            env.SYSTEM_ADMIN_EMAILS.includes(user.email.trim().toLowerCase())
          ) {
            try {
              await prisma.user.update({
                where: { id: user.id },
                data: { platformRole: PlatformRole.SYSTEM_ADMIN },
              });
            } catch {
              // Non-fatal if DB is offline mock
            }
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const defaultMembership = await prisma.member.findFirst({
            where: { userId: session.userId },
            orderBy: { createdAt: "asc" },
            select: { organizationId: true },
          });

          return {
            data: {
              ...session,
              activeOrganizationId: defaultMembership?.organizationId ?? null,
            },
          };
        },
      },
    },
  },
  plugins: [
    bearer(),
    ...(genericOAuthConfigs.length > 0
      ? [genericOAuth({ config: genericOAuthConfigs })]
      : []),
    organization({
      ac,
      roles: organizationRoles,
      allowUserToCreateOrganization: true,
      creatorRole: "owner",
      invitationExpiresIn: 60 * 60 * 48,
      cancelPendingInvitationsOnReInvite: true,
      requireEmailVerificationOnInvitation: true,
      async sendInvitationEmail(data) {
        const acceptUrl = `${env.BETTER_AUTH_URL}/api/v1/tenants/invitations/${encodeURIComponent(
          data.id,
        )}/accept`;

        await emailDelivery.sendOrganizationInvitationEmail({
          to: data.email,
          organizationName: data.organization.name,
          inviterName: data.inviter.user.name,
          inviterEmail: data.inviter.user.email,
          role: data.role,
          invitationId: data.id,
          acceptUrl,
          expiresAt: data.invitation.expiresAt,
        });
      },
      organizationHooks: {
        async afterCreateOrganization({ organization: org, user }) {
          const storageBucket = deriveOrganizationBucketName(
            org.id,
            env.RUSTFS_BUCKET_PREFIX,
          );
          await prisma.tenantSettings.upsert({
            where: { organizationId: org.id },
            update: {},
            create: {
              organizationId: org.id,
              defaultCurrency: "USD",
              timezone: "UTC",
              fiscalYearStartMonth: 1,
              storageBucket,
              storageQuotaBytes: BigInt(env.STORAGE_DEFAULT_QUOTA_BYTES),
            },
          });

          await ensureDefaultWorkScheduleId(org.id);
          await linkOrProvisionStaffForMember({
            organizationId: org.id,
            userId: user.id,
            email: user.email,
            name: user.name,
          });
          try {
            await provisionInitialTrialForOrganization(org.id, user.id, prisma);
          } catch (err) {
            console.warn(
              `[better-auth:billing] Failed to auto-provision trial for org ${org.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }

          await recordOrganizationAudit({
            organizationId: org.id,
            actorUserId: user.id,
            action: "organization.created",
            resourceType: "Organization",
            resourceId: org.id,
            metadata: { name: org.name, slug: org.slug },
          });
        },

        async afterAddMember({ member, user, organization: org }) {
          await invalidateMembershipCache(org.id, user.id);
          await linkOrProvisionStaffForMember({
            organizationId: org.id,
            memberId: member.id,
            userId: user.id,
            email: user.email,
            name: user.name,
          });
          await recordOrganizationAudit({
            organizationId: org.id,
            actorUserId: user.id,
            action: "member.added",
            resourceType: "Member",
            resourceId: member.id,
            metadata: { userId: user.id, email: user.email, role: member.role },
          });
        },

        async afterUpdateMemberRole({
          member,
          previousRole,
          user,
          organization: org,
        }) {
          await invalidateMembershipCache(org.id, user.id);
          await recordOrganizationAudit({
            organizationId: org.id,
            actorUserId: user.id,
            action: "member.role.updated",
            resourceType: "Member",
            resourceId: member.id,
            metadata: {
              userId: user.id,
              previousRole,
              newRole: member.role,
            },
          });
        },

        async afterRemoveMember({ member, user, organization: org }) {
          await invalidateMembershipCache(org.id, user.id);
          try {
            await prisma.staffProfile.updateMany({
              where: {
                organizationId: org.id,
                memberId: member.id,
              },
              data: {
                memberId: null,
                status: "OFFBOARDED",
                offboardedAt: new Date(),
              },
            });
          } catch {
            // Non-fatal if offline mock or no linked staff record
          }
          await recordOrganizationAudit({
            organizationId: org.id,
            actorUserId: user.id,
            action: "member.removed",
            resourceType: "Member",
            resourceId: member.id,
            metadata: { userId: user.id, email: user.email, role: member.role },
          });
        },

        async afterCreateInvitation({ invitation, inviter, organization: org }) {
          await recordOrganizationAudit({
            organizationId: org.id,
            actorUserId: inviter.id,
            action: "invitation.created",
            resourceType: "Invitation",
            resourceId: invitation.id,
            metadata: {
              email: invitation.email,
              role: invitation.role,
              expiresAt: invitation.expiresAt.toISOString(),
            },
          });
        },

        async afterAcceptInvitation({
          invitation,
          member,
          user,
          organization: org,
        }) {
          await invalidateMembershipCache(org.id, user.id);
          await linkOrProvisionStaffForMember({
            organizationId: org.id,
            memberId: member.id,
            userId: user.id,
            email: user.email,
            name: user.name,
          });
          await recordOrganizationAudit({
            organizationId: org.id,
            actorUserId: user.id,
            action: "invitation.accepted",
            resourceType: "Invitation",
            resourceId: invitation.id,
            metadata: {
              memberId: member.id,
              email: invitation.email,
              role: member.role,
            },
          });
        },

        async afterCancelInvitation({
          invitation,
          cancelledBy,
          organization: org,
        }) {
          await recordOrganizationAudit({
            organizationId: org.id,
            actorUserId: cancelledBy.id,
            action: "invitation.cancelled",
            resourceType: "Invitation",
            resourceId: invitation.id,
            metadata: {
              email: invitation.email,
              role: invitation.role,
            },
          });
        },

        async afterRejectInvitation({ invitation, user, organization: org }) {
          await recordOrganizationAudit({
            organizationId: org.id,
            actorUserId: user.id,
            action: "invitation.rejected",
            resourceType: "Invitation",
            resourceId: invitation.id,
            metadata: {
              email: invitation.email,
              role: invitation.role,
            },
          });
        },
      },
    }),
  ],
});
