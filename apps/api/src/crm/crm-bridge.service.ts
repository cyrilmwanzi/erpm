import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ItemStatus,
  ItemType,
  PriceBookDirection,
  StaffStatus,
  type Prisma,
} from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import { PricingEngineService } from "../pricing/pricing-engine.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { CrmConnectionService } from "./crm-connection.service.js";
import { CustomerMatesClient } from "./customermates.client.js";

export interface UpsertStaffMappingInput {
  staffId: string;
  externalUserId: string;
  externalEmail?: string | null;
  externalName?: string | null;
}

export interface LinkDealItemInput {
  itemId: string;
  packId?: string | null;
  servicePlanId?: string | null;
  priceBookId?: string | null;
  customerSegment?: string | null;
  externalAccountId?: string | null;
  promoCode?: string | null;
  externalServiceId?: string | null;
  quantity?: number;
  unitPriceCents?: number;
  currency?: string;
  notes?: string | null;
}

export interface PushCatalogToCrmInput {
  itemIds?: string[];
  types?: ItemType[];
}

@Injectable()
export class CrmBridgeService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(CrmConnectionService)
    private readonly connectionService: CrmConnectionService,
    @Inject(CustomerMatesClient)
    private readonly customerMatesClient: CustomerMatesClient,
    @Inject(PricingEngineService)
    private readonly pricingEngine: PricingEngineService,
  ) {}

  async upsertStaffMapping(
    tenant: AuthenticatedOrganization,
    input: UpsertStaffMappingInput,
    ipAddress?: string,
  ) {
    const externalUserId = input.externalUserId.trim();
    const externalEmail = input.externalEmail?.trim().toLowerCase() || null;

    return this.prismaService.raw.$transaction(async (tx) => {
      const staff = await tx.staffProfile.findFirst({
        where: { id: input.staffId, organizationId: tenant.organizationId },
        select: {
          id: true,
          displayName: true,
          workEmail: true,
          jobTitle: true,
          status: true,
        },
      });
      if (!staff) {
        throw new NotFoundException(
          `Staff profile (${input.staffId}) was not found in the active organization.`,
        );
      }
      if (staff.status === StaffStatus.OFFBOARDED) {
        throw new BadRequestException(
          "Cannot map an offboarded staff member to a CRM assignee.",
        );
      }

      const conflictingExternal = await tx.crmStaffMapping.findFirst({
        where: {
          organizationId: tenant.organizationId,
          externalUserId,
          staffId: { not: staff.id },
        },
        select: { id: true },
      });
      if (conflictingExternal) {
        throw new ConflictException(
          `CustomerMates user ID "${externalUserId}" is already mapped to another staff profile.`,
        );
      }

      const existing = await tx.crmStaffMapping.findFirst({
        where: { organizationId: tenant.organizationId, staffId: staff.id },
      });

      const saved = existing
        ? await tx.crmStaffMapping.update({
            where: { id: existing.id },
            data: {
              externalUserId,
              externalEmail: externalEmail ?? staff.workEmail,
              externalName: input.externalName?.trim() || staff.displayName,
            },
            include: {
              staff: {
                select: {
                  id: true,
                  displayName: true,
                  workEmail: true,
                  jobTitle: true,
                  status: true,
                },
              },
            },
          })
        : await tx.crmStaffMapping.create({
            data: {
              organizationId: tenant.organizationId,
              staffId: staff.id,
              externalUserId,
              externalEmail: externalEmail ?? staff.workEmail,
              externalName: input.externalName?.trim() || staff.displayName,
              createdByUserId: tenant.userId,
            },
            include: {
              staff: {
                select: {
                  id: true,
                  displayName: true,
                  workEmail: true,
                  jobTitle: true,
                  status: true,
                },
              },
            },
          });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "crm.staff_mapping.upserted",
          resourceType: "CrmStaffMapping",
          resourceId: saved.id,
          metadata: {
            staffId: staff.id,
            externalUserId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });
  }

  async listStaffMappings(tenant: AuthenticatedOrganization) {
    const items = await this.prismaService.scoped.crmStaffMapping.findMany({
      where: { organizationId: tenant.organizationId },
      orderBy: { createdAt: "desc" },
      include: {
        staff: {
          select: {
            id: true,
            displayName: true,
            workEmail: true,
            jobTitle: true,
            status: true,
            departmentId: true,
          },
        },
      },
    });

    return {
      organizationId: tenant.organizationId,
      items,
    };
  }

  async deleteStaffMapping(
    tenant: AuthenticatedOrganization,
    staffId: string,
    ipAddress?: string,
  ) {
    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.crmStaffMapping.findFirst({
        where: { organizationId: tenant.organizationId, staffId },
      });
      if (!existing) {
        throw new NotFoundException("Staff CRM mapping not found.");
      }

      await tx.crmStaffMapping.delete({ where: { id: existing.id } });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "crm.staff_mapping.deleted",
          resourceType: "CrmStaffMapping",
          resourceId: existing.id,
          metadata: {
            staffId,
            externalUserId: existing.externalUserId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return { deleted: true, staffId };
    });
  }

  async resolveExternalOwnerFromStaff(
    organizationId: string,
    ownerStaffId: string,
  ): Promise<{ externalUserId: string; staffId: string }> {
    const mapping = await this.prismaService.raw.crmStaffMapping.findFirst({
      where: { organizationId, staffId: ownerStaffId },
      select: { externalUserId: true, staffId: true },
    });

    if (!mapping) {
      throw new BadRequestException(
        `Staff profile (${ownerStaffId}) is not mapped to a CustomerMates user. Create a mapping at /api/v1/crm/staff-mappings first.`,
      );
    }

    return mapping;
  }

  async getStaffMappingIndex(organizationId: string) {
    const rows = await this.prismaService.raw.crmStaffMapping.findMany({
      where: { organizationId },
      include: {
        staff: {
          select: {
            id: true,
            displayName: true,
            workEmail: true,
            jobTitle: true,
            departmentId: true,
          },
        },
      },
    });

    const byExternalId = new Map(rows.map((r) => [r.externalUserId, r.staff]));
    return byExternalId;
  }

  async linkItemToDeal(
    tenant: AuthenticatedOrganization,
    externalDealId: string,
    input: LinkDealItemInput,
    ipAddress?: string,
  ) {
    const quantity = input.quantity ?? 1;
    const item = await this.prismaService.scoped.item.findUnique({
      where: { id: input.itemId },
      select: {
        id: true,
        sku: true,
        name: true,
        type: true,
        status: true,
        currency: true,
        salePriceCents: true,
      },
    });

    if (!item) {
      throw new NotFoundException(
        `Catalog item (${input.itemId}) was not found in the active organization.`,
      );
    }
    if (item.status === ItemStatus.ARCHIVED) {
      throw new BadRequestException(
        "Cannot link an archived catalog item to a CRM deal.",
      );
    }

    const currency = (input.currency ?? item.currency).toUpperCase();
    const promoCode = input.promoCode?.trim().toUpperCase() || null;

    const quote = await this.pricingEngine.calculateQuote(tenant, {
      direction: PriceBookDirection.SALES,
      currency,
      priceBookId: input.priceBookId ?? null,
      customerSegment: input.customerSegment ?? null,
      externalAccountId: input.externalAccountId ?? null,
      promoCodes: promoCode ? [promoCode] : undefined,
      lines: [
        {
          itemId: item.id,
          quantity,
          packId: input.packId ?? null,
          servicePlanId: input.servicePlanId ?? null,
          overrideUnitPriceCents: input.unitPriceCents ?? null,
        },
      ],
    });

    const quotedLine = quote.lines[0]!;
    const unitPriceCents =
      input.unitPriceCents ?? quotedLine.effectiveUnitPriceCents;
    const baseSubtotalCents = quotedLine.baseSubtotalCents;
    const discountCents = quotedLine.lineDiscountCents;
    const appliedPricing = {
      pricingModel: quotedLine.pricingModel,
      priceBookId: quotedLine.priceBookId,
      priceBookCode: quotedLine.priceBookCode,
      listUnitPriceCents: quotedLine.listUnitPriceCents,
      effectiveUnitPriceCents: quotedLine.effectiveUnitPriceCents,
      unitsPerPack: quotedLine.unitsPerPack,
      totalBaseUnits: quotedLine.totalBaseUnits,
      bonusUnits: quotedLine.bonusUnits,
      finalLineTotalCents: quotedLine.finalLineTotalCents,
      appliedTiers: quotedLine.appliedTiers,
      appliedDiscounts: quotedLine.appliedDiscounts,
      bundleBreakdown: quotedLine.bundleBreakdown,
      servicePlanSummary: quotedLine.servicePlanSummary,
    };

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.crmDealItemLink.findFirst({
        where: {
          organizationId: tenant.organizationId,
          externalDealId,
          itemId: item.id,
        },
      });

      const includeSpec = {
        item: {
          select: {
            id: true,
            sku: true,
            name: true,
            type: true,
            unitOfMeasure: true,
          },
        },
        pack: {
          select: {
            id: true,
            code: true,
            name: true,
            unitOfMeasure: true,
            unitsPerPack: true,
          },
        },
        servicePlan: {
          select: {
            id: true,
            code: true,
            name: true,
            planType: true,
            billingCycle: true,
            includedUnits: true,
            unitLabel: true,
          },
        },
      };

      const saved = existing
        ? await tx.crmDealItemLink.update({
            where: { id: existing.id },
            data: {
              packId: input.packId !== undefined ? input.packId : existing.packId,
              servicePlanId:
                input.servicePlanId !== undefined
                  ? input.servicePlanId
                  : existing.servicePlanId,
              priceBookId:
                quotedLine.priceBookId ?? input.priceBookId ?? existing.priceBookId,
              promoCode: promoCode ?? existing.promoCode,
              externalServiceId:
                input.externalServiceId !== undefined
                  ? input.externalServiceId
                  : existing.externalServiceId,
              quantity,
              unitPriceCents,
              baseSubtotalCents,
              discountCents,
              currency,
              appliedPricing: appliedPricing as unknown as Prisma.InputJsonValue,
              notes:
                input.notes !== undefined ? input.notes : existing.notes,
            },
            include: includeSpec,
          })
        : await tx.crmDealItemLink.create({
            data: {
              organizationId: tenant.organizationId,
              externalDealId,
              itemId: item.id,
              packId: input.packId ?? null,
              servicePlanId: input.servicePlanId ?? null,
              priceBookId: quotedLine.priceBookId ?? input.priceBookId ?? null,
              promoCode,
              externalServiceId: input.externalServiceId ?? null,
              quantity,
              unitPriceCents,
              baseSubtotalCents,
              discountCents,
              currency,
              appliedPricing: appliedPricing as unknown as Prisma.InputJsonValue,
              notes: input.notes ?? null,
              createdByUserId: tenant.userId,
            },
            include: includeSpec,
          });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "crm.deal_item.linked",
          resourceType: "CrmDealItemLink",
          resourceId: saved.id,
          metadata: {
            externalDealId,
            itemId: item.id,
            packId: saved.packId,
            servicePlanId: saved.servicePlanId,
            priceBookId: saved.priceBookId,
            quantity,
            unitPriceCents,
            discountCents,
            currency,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        ...saved,
        lineTotalCents: quotedLine.finalLineTotalCents,
      };
    });
  }

  async listDealItems(tenant: AuthenticatedOrganization, externalDealId: string) {
    const links = await this.prismaService.scoped.crmDealItemLink.findMany({
      where: {
        organizationId: tenant.organizationId,
        externalDealId,
      },
      orderBy: { createdAt: "asc" },
      include: {
        item: {
          select: {
            id: true,
            sku: true,
            name: true,
            type: true,
            status: true,
            unitOfMeasure: true,
            salePriceCents: true,
            currency: true,
          },
        },
        pack: {
          select: {
            id: true,
            code: true,
            name: true,
            unitOfMeasure: true,
            unitsPerPack: true,
          },
        },
        servicePlan: {
          select: {
            id: true,
            code: true,
            name: true,
            planType: true,
            billingCycle: true,
            includedUnits: true,
            unitLabel: true,
          },
        },
      },
    });

    const items = links.map((link) => {
      const snap = link.appliedPricing as { finalLineTotalCents?: number } | null;
      const lineTotalCents =
        typeof snap?.finalLineTotalCents === "number"
          ? snap.finalLineTotalCents
          : link.quantity * link.unitPriceCents;
      return {
        ...link,
        lineTotalCents,
      };
    });

    const subtotalCents = items.reduce(
      (sum, row) => sum + row.lineTotalCents,
      0,
    );
    const totalDiscountCents = items.reduce(
      (sum, row) => sum + (row.discountCents ?? 0),
      0,
    );

    return {
      organizationId: tenant.organizationId,
      externalDealId,
      subtotalCents,
      totalDiscountCents,
      items,
    };
  }

  async unlinkItemFromDeal(
    tenant: AuthenticatedOrganization,
    externalDealId: string,
    itemId: string,
    ipAddress?: string,
  ) {
    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.crmDealItemLink.findFirst({
        where: {
          organizationId: tenant.organizationId,
          externalDealId,
          itemId,
        },
      });
      if (!existing) {
        throw new NotFoundException("Deal catalog item link not found.");
      }

      await tx.crmDealItemLink.delete({ where: { id: existing.id } });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "crm.deal_item.unlinked",
          resourceType: "CrmDealItemLink",
          resourceId: existing.id,
          metadata: { externalDealId, itemId } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return { deleted: true, externalDealId, itemId };
    });
  }

  async pushCatalogToCustomerMates(
    tenant: AuthenticatedOrganization,
    input: PushCatalogToCrmInput,
    ipAddress?: string,
  ) {
    const ctx = await this.connectionService.resolveActiveConnection(
      tenant.organizationId,
    );

    const allowedTypes =
      input.types && input.types.length > 0
        ? input.types
        : [ItemType.SELLABLE, ItemType.SERVICE];

    const catalogItems = await this.prismaService.scoped.item.findMany({
      where: {
        organizationId: tenant.organizationId,
        status: ItemStatus.ACTIVE,
        type: { in: allowedTypes },
        ...(input.itemIds && input.itemIds.length > 0
          ? { id: { in: input.itemIds } }
          : {}),
      },
      take: 50,
      orderBy: { name: "asc" },
    });

    const pushed: Array<{ itemId: string; sku: string; externalServiceId: string }> = [];

    for (const item of catalogItems) {
      const created = await this.customerMatesClient.createResource(
        ctx,
        "services",
        {
          name: item.name,
          description: item.description ?? undefined,
          sku: item.sku,
          priceCents: item.salePriceCents,
          price: Number((item.salePriceCents / 100).toFixed(2)),
          currency: item.currency,
          unit: item.unitOfMeasure,
          externalId: item.id,
        },
      );
      pushed.push({
        itemId: item.id,
        sku: item.sku,
        externalServiceId: created.id,
      });
    }

    await this.prismaService.scoped.auditLog.create({
      data: {
        organizationId: tenant.organizationId,
        actorUserId: tenant.userId,
        action: "crm.catalog.pushed",
        resourceType: "Item",
        metadata: {
          count: pushed.length,
          itemIds: pushed.map((p) => p.itemId),
        } as Prisma.InputJsonValue,
        ipAddress: ipAddress ?? null,
      },
    });

    return {
      organizationId: tenant.organizationId,
      pushedCount: pushed.length,
      services: pushed,
    };
  }
}
