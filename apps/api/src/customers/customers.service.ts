import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CrmProvider,
  CustomerStatus,
  CustomerType,
  Prisma,
  OrganizationContext,
} from "@scace/db";
import { CrmConnectionService } from "../crm/crm-connection.service.js";
import { CustomerMatesClient } from "../crm/customermates.client.js";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";

export interface CreateCustomerInput {
  code?: string;
  type?: CustomerType;
  status?: CustomerStatus;
  name: string;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  taxId?: string | null;
  customerSegment?: string | null;
  currency?: string;
  paymentTermsDays?: number;
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingPostalCode?: string | null;
  billingCountry?: string | null;
  shippingAddressLine1?: string | null;
  shippingAddressLine2?: string | null;
  shippingCity?: string | null;
  shippingState?: string | null;
  shippingPostalCode?: string | null;
  shippingCountry?: string | null;
  externalContactId?: string | null;
  externalCompanyId?: string | null;
  externalAccountId?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateCustomerInput {
  type?: CustomerType;
  status?: "ACTIVE" | "INACTIVE";
  name?: string;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  taxId?: string | null;
  customerSegment?: string | null;
  currency?: string;
  paymentTermsDays?: number;
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingPostalCode?: string | null;
  billingCountry?: string | null;
  shippingAddressLine1?: string | null;
  shippingAddressLine2?: string | null;
  shippingCity?: string | null;
  shippingState?: string | null;
  shippingPostalCode?: string | null;
  shippingCountry?: string | null;
  externalContactId?: string | null;
  externalCompanyId?: string | null;
  externalAccountId?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ListCustomersQuery {
  type?: CustomerType;
  status?: CustomerStatus;
  customerSegment?: string;
  hasCrmLink?: boolean;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface LinkCustomerCrmInput {
  externalContactId?: string | null;
  externalCompanyId?: string | null;
  externalAccountId?: string | null;
  pushToCrm?: boolean;
}

export interface ImportCustomerFromCrmInput {
  externalContactId?: string;
  externalCompanyId?: string;
  type?: CustomerType;
  customerSegment?: string | null;
  paymentTermsDays?: number;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function generateCustomerCode(type: CustomerType): string {
  const prefix = type === CustomerType.BUSINESS ? "B2B" : "CUS";
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

@Injectable()
export class CustomersService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(CrmConnectionService)
    private readonly crmConnectionService: CrmConnectionService,
    @Inject(CustomerMatesClient)
    private readonly customerMatesClient: CustomerMatesClient,
  ) {}

  async createCustomer(
    tenant: AuthenticatedOrganization,
    input: CreateCustomerInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const type = input.type ?? CustomerType.INDIVIDUAL;
    const code = input.code?.trim().toUpperCase() || generateCustomerCode(type);
    const hasCrmLink = Boolean(
      input.externalContactId || input.externalCompanyId || input.externalAccountId,
    );

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        const settings = await tx.organizationSettings.findUnique({
          where: { organizationId },
          select: { defaultCurrency: true },
        });

        const currency = (
          input.currency ??
          settings?.defaultCurrency ??
          "USD"
        ).toUpperCase();

        const created = await tx.customer.create({
          data: {
            organizationId,
            code,
            type,
            status: input.status ?? CustomerStatus.ACTIVE,
            name: input.name.trim(),
            companyName: input.companyName?.trim() || null,
            email: input.email?.trim().toLowerCase() || null,
            phone: input.phone?.trim() || null,
            taxId: input.taxId?.trim() || null,
            customerSegment: input.customerSegment?.trim() || null,
            currency,
            paymentTermsDays:
              input.paymentTermsDays ?? (type === CustomerType.BUSINESS ? 30 : 0),
            billingAddressLine1: input.billingAddressLine1?.trim() || null,
            billingAddressLine2: input.billingAddressLine2?.trim() || null,
            billingCity: input.billingCity?.trim() || null,
            billingState: input.billingState?.trim() || null,
            billingPostalCode: input.billingPostalCode?.trim() || null,
            billingCountry: input.billingCountry?.trim() || null,
            shippingAddressLine1: input.shippingAddressLine1?.trim() || null,
            shippingAddressLine2: input.shippingAddressLine2?.trim() || null,
            shippingCity: input.shippingCity?.trim() || null,
            shippingState: input.shippingState?.trim() || null,
            shippingPostalCode: input.shippingPostalCode?.trim() || null,
            shippingCountry: input.shippingCountry?.trim() || null,
            crmProvider: hasCrmLink ? CrmProvider.CUSTOMERMATES : null,
            externalContactId: input.externalContactId?.trim() || null,
            externalCompanyId: input.externalCompanyId?.trim() || null,
            externalAccountId:
              input.externalAccountId?.trim() ||
              input.externalCompanyId?.trim() ||
              input.externalContactId?.trim() ||
              null,
            crmLastSyncedAt: hasCrmLink ? new Date() : null,
            notes: input.notes?.trim() || null,
            metadata: (input.metadata ?? undefined) as
              | Prisma.InputJsonValue
              | undefined,
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "customer.created",
            resourceType: "Customer",
            resourceId: created.id,
            metadata: {
              code: created.code,
              type: created.type,
              name: created.name,
              hasCrmLink,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Customer code "${code}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async listCustomers(tenant: AuthenticatedOrganization, query: ListCustomersQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.customer.findMany({
      where: {
        ...(query.type ? { type: query.type } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.customerSegment
          ? { customerSegment: query.customerSegment }
          : {}),
        ...(query.hasCrmLink === true
          ? {
              OR: [
                { externalContactId: { not: null } },
                { externalCompanyId: { not: null } },
                { externalAccountId: { not: null } },
              ],
            }
          : query.hasCrmLink === false
            ? {
                externalContactId: null,
                externalCompanyId: null,
                externalAccountId: null,
              }
            : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search, mode: "insensitive" } },
                { name: { contains: search, mode: "insensitive" } },
                { companyName: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
                { phone: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        _count: {
          select: { orders: true, invoices: true, payments: true },
        },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const hasMore = records.length > take;
    const items = hasMore ? records.slice(0, take) : records;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return {
      organizationId: tenant.organizationId,
      items,
      nextCursor,
    };
  }

  async getCustomer(tenant: AuthenticatedOrganization, customerId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    const customer = await this.prismaService.scoped.customer.findUnique({
      where: { id: customerId },
      include: {
        _count: {
          select: { orders: true, invoices: true, payments: true, receipts: true },
        },
      },
    });

    if (!customer) {
      throw new NotFoundException("Customer was not found.");
    }

    return customer;
  }

  async updateCustomer(
    tenant: AuthenticatedOrganization,
    customerId: string,
    input: UpdateCustomerInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: { id: customerId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Customer was not found.");
      }
      if (existing.status === CustomerStatus.ARCHIVED) {
        throw new BadRequestException(
          "Archived customers must be restored before editing.",
        );
      }

      const nextContactId =
        input.externalContactId !== undefined
          ? input.externalContactId?.trim() || null
          : existing.externalContactId;
      const nextCompanyId =
        input.externalCompanyId !== undefined
          ? input.externalCompanyId?.trim() || null
          : existing.externalCompanyId;
      const nextAccountId =
        input.externalAccountId !== undefined
          ? input.externalAccountId?.trim() || null
          : existing.externalAccountId;
      const hasCrmLink = Boolean(nextContactId || nextCompanyId || nextAccountId);

      const updated = await tx.customer.update({
        where: { id: existing.id },
        data: {
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.companyName !== undefined
            ? { companyName: input.companyName?.trim() || null }
            : {}),
          ...(input.email !== undefined
            ? { email: input.email?.trim().toLowerCase() || null }
            : {}),
          ...(input.phone !== undefined
            ? { phone: input.phone?.trim() || null }
            : {}),
          ...(input.taxId !== undefined
            ? { taxId: input.taxId?.trim() || null }
            : {}),
          ...(input.customerSegment !== undefined
            ? { customerSegment: input.customerSegment?.trim() || null }
            : {}),
          ...(input.currency !== undefined
            ? { currency: input.currency.toUpperCase() }
            : {}),
          ...(input.paymentTermsDays !== undefined
            ? { paymentTermsDays: input.paymentTermsDays }
            : {}),
          ...(input.billingAddressLine1 !== undefined
            ? { billingAddressLine1: input.billingAddressLine1?.trim() || null }
            : {}),
          ...(input.billingAddressLine2 !== undefined
            ? { billingAddressLine2: input.billingAddressLine2?.trim() || null }
            : {}),
          ...(input.billingCity !== undefined
            ? { billingCity: input.billingCity?.trim() || null }
            : {}),
          ...(input.billingState !== undefined
            ? { billingState: input.billingState?.trim() || null }
            : {}),
          ...(input.billingPostalCode !== undefined
            ? { billingPostalCode: input.billingPostalCode?.trim() || null }
            : {}),
          ...(input.billingCountry !== undefined
            ? { billingCountry: input.billingCountry?.trim() || null }
            : {}),
          ...(input.shippingAddressLine1 !== undefined
            ? { shippingAddressLine1: input.shippingAddressLine1?.trim() || null }
            : {}),
          ...(input.shippingAddressLine2 !== undefined
            ? { shippingAddressLine2: input.shippingAddressLine2?.trim() || null }
            : {}),
          ...(input.shippingCity !== undefined
            ? { shippingCity: input.shippingCity?.trim() || null }
            : {}),
          ...(input.shippingState !== undefined
            ? { shippingState: input.shippingState?.trim() || null }
            : {}),
          ...(input.shippingPostalCode !== undefined
            ? { shippingPostalCode: input.shippingPostalCode?.trim() || null }
            : {}),
          ...(input.shippingCountry !== undefined
            ? { shippingCountry: input.shippingCountry?.trim() || null }
            : {}),
          externalContactId: nextContactId,
          externalCompanyId: nextCompanyId,
          externalAccountId: nextAccountId,
          crmProvider: hasCrmLink ? CrmProvider.CUSTOMERMATES : null,
          ...(input.notes !== undefined
            ? { notes: input.notes?.trim() || null }
            : {}),
          ...(input.metadata !== undefined
            ? {
                metadata:
                  input.metadata === null
                    ? Prisma.JsonNull
                    : (input.metadata as Prisma.InputJsonValue),
              }
            : {}),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "customer.updated",
          resourceType: "Customer",
          resourceId: updated.id,
          metadata: {
            code: updated.code,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async archiveCustomer(
    tenant: AuthenticatedOrganization,
    customerId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: { id: customerId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Customer was not found.");
      }
      if (existing.status === CustomerStatus.ARCHIVED) {
        return existing;
      }

      const archived = await tx.customer.update({
        where: { id: existing.id },
        data: {
          status: CustomerStatus.ARCHIVED,
          archivedAt: new Date(),
          archivedByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "customer.archived",
          resourceType: "Customer",
          resourceId: archived.id,
          metadata: { code: archived.code } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return archived;
    });
  }

  async restoreCustomer(
    tenant: AuthenticatedOrganization,
    customerId: string,
    status: "ACTIVE" | "INACTIVE" = "ACTIVE",
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: { id: customerId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Customer was not found.");
      }

      const restored = await tx.customer.update({
        where: { id: existing.id },
        data: {
          status,
          archivedAt: null,
          archivedByUserId: null,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "customer.restored",
          resourceType: "Customer",
          resourceId: restored.id,
          metadata: {
            code: restored.code,
            status,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return restored;
    });
  }

  async linkCustomerToCrm(
    tenant: AuthenticatedOrganization,
    customerId: string,
    input: LinkCustomerCrmInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing = await this.prismaService.scoped.customer.findUnique({
      where: { id: customerId },
    });
    if (!existing) {
      throw new NotFoundException("Customer was not found.");
    }
    if (existing.status === CustomerStatus.ARCHIVED) {
      throw new BadRequestException(
        "Cannot link an archived customer to CRM.",
      );
    }

    let externalContactId =
      input.externalContactId !== undefined
        ? input.externalContactId?.trim() || null
        : existing.externalContactId;
    let externalCompanyId =
      input.externalCompanyId !== undefined
        ? input.externalCompanyId?.trim() || null
        : existing.externalCompanyId;
    let externalAccountId =
      input.externalAccountId !== undefined
        ? input.externalAccountId?.trim() || null
        : existing.externalAccountId;

    if (input.pushToCrm) {
      const ctx = await this.crmConnectionService.resolveActiveConnection(
        organizationId,
      );

      if (existing.type === CustomerType.BUSINESS) {
        const companyName = existing.companyName || existing.name;
        if (externalCompanyId) {
          await this.customerMatesClient.updateResource(
            ctx,
            "organizations",
            externalCompanyId,
            {
              name: companyName,
              email: existing.email ?? undefined,
              phone: existing.phone ?? undefined,
              externalId: existing.id,
            },
          );
        } else {
          const createdCompany = await this.customerMatesClient.createResource(
            ctx,
            "organizations",
            {
              name: companyName,
              email: existing.email ?? undefined,
              phone: existing.phone ?? undefined,
              externalId: existing.id,
            },
          );
          externalCompanyId = createdCompany.id;
        }
      }

      if (externalContactId) {
        await this.customerMatesClient.updateResource(
          ctx,
          "contacts",
          externalContactId,
          {
            name: existing.name,
            email: existing.email ?? undefined,
            phone: existing.phone ?? undefined,
            organizationId: externalCompanyId ?? undefined,
            externalId: existing.id,
          },
        );
      } else {
        const createdContact = await this.customerMatesClient.createResource(
          ctx,
          "contacts",
          {
            name: existing.name,
            email: existing.email ?? undefined,
            phone: existing.phone ?? undefined,
            organizationId: externalCompanyId ?? undefined,
            externalId: existing.id,
          },
        );
        externalContactId = createdContact.id;
      }

      externalAccountId =
        externalAccountId ?? externalCompanyId ?? externalContactId;
    }

    if (!externalContactId && !externalCompanyId && !externalAccountId) {
      throw new BadRequestException(
        "Provide at least one CRM ID or set pushToCrm: true.",
      );
    }

    const resolvedAccountId =
      externalAccountId ?? externalCompanyId ?? externalContactId;

    return this.prismaService.raw.$transaction(async (tx) => {
      const updated = await tx.customer.update({
        where: { id: existing.id },
        data: {
          crmProvider: CrmProvider.CUSTOMERMATES,
          externalContactId,
          externalCompanyId,
          externalAccountId: resolvedAccountId,
          crmLastSyncedAt: new Date(),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "customer.crm_linked",
          resourceType: "Customer",
          resourceId: updated.id,
          metadata: {
            code: updated.code,
            pushToCrm: Boolean(input.pushToCrm),
            externalContactId,
            externalCompanyId,
            externalAccountId: resolvedAccountId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async importCustomerFromCrm(
    tenant: AuthenticatedOrganization,
    input: ImportCustomerFromCrmInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    if (!input.externalContactId && !input.externalCompanyId) {
      throw new BadRequestException(
        "Provide externalContactId and/or externalCompanyId to import from CRM.",
      );
    }

    const ctx = await this.crmConnectionService.resolveActiveConnection(
      organizationId,
    );

    const contact = input.externalContactId
      ? await this.customerMatesClient.getResource(
          ctx,
          "contacts",
          input.externalContactId,
        )
      : null;

    const company = input.externalCompanyId
      ? await this.customerMatesClient.getResource(
          ctx,
          "organizations",
          input.externalCompanyId,
        )
      : null;

    const resolvedName =
      this.pickString(contact, ["name", "fullName"]) ||
      this.pickString(company, ["name"]) ||
      "CRM Customer";
    const resolvedCompanyName = this.pickString(company, ["name"]);
    const resolvedEmail =
      this.pickString(contact, ["email"]) ??
      this.pickString(company, ["email"]);
    const resolvedPhone =
      this.pickString(contact, ["phone", "mobile"]) ??
      this.pickString(company, ["phone"]);

    const inferredType =
      input.type ??
      (input.externalCompanyId ? CustomerType.BUSINESS : CustomerType.INDIVIDUAL);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: {
          organizationId,
          OR: [
            ...(input.externalContactId
              ? [{ externalContactId: input.externalContactId }]
              : []),
            ...(input.externalCompanyId
              ? [{ externalCompanyId: input.externalCompanyId }]
              : []),
          ],
        },
      });

      const saved = existing
        ? await tx.customer.update({
            where: { id: existing.id },
            data: {
              name: resolvedName,
              companyName: resolvedCompanyName ?? existing.companyName,
              email: resolvedEmail?.toLowerCase() ?? existing.email,
              phone: resolvedPhone ?? existing.phone,
              crmProvider: CrmProvider.CUSTOMERMATES,
              externalContactId:
                input.externalContactId ?? existing.externalContactId,
              externalCompanyId:
                input.externalCompanyId ?? existing.externalCompanyId,
              externalAccountId:
                input.externalCompanyId ??
                input.externalContactId ??
                existing.externalAccountId,
              crmLastSyncedAt: new Date(),
              ...(input.customerSegment !== undefined
                ? { customerSegment: input.customerSegment }
                : {}),
              updatedByUserId: tenant.userId,
            },
          })
        : await tx.customer.create({
            data: {
              organizationId,
              code: generateCustomerCode(inferredType),
              type: inferredType,
              status: CustomerStatus.ACTIVE,
              name: resolvedName,
              companyName: resolvedCompanyName,
              email: resolvedEmail?.toLowerCase() ?? null,
              phone: resolvedPhone,
              customerSegment: input.customerSegment ?? null,
              paymentTermsDays:
                input.paymentTermsDays ??
                (inferredType === CustomerType.BUSINESS ? 30 : 0),
              crmProvider: CrmProvider.CUSTOMERMATES,
              externalContactId: input.externalContactId ?? null,
              externalCompanyId: input.externalCompanyId ?? null,
              externalAccountId:
                input.externalCompanyId ?? input.externalContactId ?? null,
              crmLastSyncedAt: new Date(),
              createdByUserId: tenant.userId,
              updatedByUserId: tenant.userId,
            },
          });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "customer.crm_imported",
          resourceType: "Customer",
          resourceId: saved.id,
          metadata: {
            code: saved.code,
            externalContactId: saved.externalContactId,
            externalCompanyId: saved.externalCompanyId,
            updatedExisting: Boolean(existing),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });
  }

  private pickString(
    record: Record<string, unknown> | null,
    keys: string[],
  ): string | null {
    if (!record) return null;
    for (const k of keys) {
      const val = record[k];
      if (typeof val === "string" && val.trim().length > 0) {
        return val.trim();
      }
    }
    return null;
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedOrganization): string {
    const contextOrgId = OrganizationContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active organization context mismatch.");
    }
    return tenant.organizationId;
  }
}
