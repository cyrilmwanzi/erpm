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
  ItemVariantKind,
  Prisma,
  OrganizationContext,
  VariantOptionDisplayType,
} from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import { RedisService } from "../redis/redis.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";

export interface OptionValueInput {
  code: string;
  label: string;
  swatchHex?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface CreateVariantOptionInput {
  code: string;
  name: string;
  displayType?: VariantOptionDisplayType;
  sortOrder?: number;
  isActive?: boolean;
  metadata?: Record<string, unknown> | null;
  values?: OptionValueInput[];
}

export interface UpdateVariantOptionInput {
  name?: string;
  displayType?: VariantOptionDisplayType;
  sortOrder?: number;
  isActive?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateOptionValueInput {
  label?: string;
  swatchHex?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface ListVariantOptionsQuery {
  displayType?: VariantOptionDisplayType;
  isActive?: boolean;
  search?: string;
}

export interface TemplateOptionConfigInput {
  optionId: string;
  valueIds?: string[];
  sortOrder?: number;
}

export interface CreateTemplateInput {
  sku: string;
  name: string;
  description?: string | null;
  type: ItemType;
  status?: "DRAFT" | "ACTIVE";
  unitOfMeasure?: string;
  currency?: string;
  salePriceCents?: number;
  costPriceCents?: number;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
  options?: TemplateOptionConfigInput[];
  autoGenerateMatrix?: boolean;
  skuPattern?: string;
  namePattern?: string;
  reason?: string;
}

export interface PromoteToTemplateInput {
  options?: TemplateOptionConfigInput[];
  autoGenerateMatrix?: boolean;
  skuPattern?: string;
  namePattern?: string;
  reason?: string;
}

export interface ListTemplatesQuery {
  type?: ItemType;
  status?: ItemStatus;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface MatrixSelectionInput {
  optionId: string;
  valueIds?: string[];
}

export interface PreviewMatrixInput {
  selections?: MatrixSelectionInput[];
  skuPattern?: string;
  namePattern?: string;
  maxCombinations?: number;
}

export interface MatrixVariantOverrideInput {
  sku?: string;
  name?: string;
  status?: "DRAFT" | "ACTIVE";
  inheritParentPricing?: boolean;
  salePriceOverrideCents?: number | null;
  costPriceOverrideCents?: number | null;
  trackInventory?: boolean;
  allowNegativeStock?: boolean;
  reorderPoint?: number | null;
}

export interface GenerateMatrixInput extends PreviewMatrixInput {
  skipConflicts?: boolean;
  defaultStatus?: "DRAFT" | "ACTIVE";
  defaultTrackInventory?: boolean;
  defaultAllowNegativeStock?: boolean;
  defaultReorderPoint?: number | null;
  overridesByVariantKey?: Record<string, MatrixVariantOverrideInput>;
  reason?: string;
}

export interface VariantAttributeInput {
  optionId?: string;
  optionCode?: string;
  optionValueId?: string;
  valueCode?: string;
}

export interface CreateVariantInput {
  sku?: string;
  name?: string;
  description?: string | null;
  status?: "DRAFT" | "ACTIVE";
  inheritParentPricing?: boolean;
  salePriceOverrideCents?: number | null;
  costPriceOverrideCents?: number | null;
  trackInventory?: boolean;
  allowNegativeStock?: boolean;
  reorderPoint?: number | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
  attributes: VariantAttributeInput[];
  reason?: string;
}

export interface UpdateVariantInput {
  sku?: string;
  name?: string;
  description?: string | null;
  status?: "DRAFT" | "ACTIVE";
  inheritParentPricing?: boolean;
  salePriceOverrideCents?: number | null;
  costPriceOverrideCents?: number | null;
  trackInventory?: boolean;
  allowNegativeStock?: boolean;
  reorderPoint?: number | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
  expectedVersion?: number;
  reason?: string;
}

export interface BulkUpdateVariantsInput {
  variantIds: string[];
  status?: "DRAFT" | "ACTIVE";
  inheritParentPricing?: boolean;
  salePriceOverrideCents?: number | null;
  costPriceOverrideCents?: number | null;
  allowNegativeStock?: boolean;
  reorderPoint?: number | null;
  reason?: string;
}

export interface ResolveVariantByAttributesInput {
  attributes: VariantAttributeInput[];
}

export interface MatrixAttributeDescriptor {
  optionId: string;
  optionCode: string;
  optionName: string;
  optionValueId: string;
  valueCode: string;
  valueLabel: string;
  swatchHex: string | null;
}

export interface MatrixPreviewEntry {
  variantKey: string;
  attributes: MatrixAttributeDescriptor[];
  suggestedSku: string;
  suggestedName: string;
  status: "CREATE" | "EXISTING" | "CONFLICT";
  existingItemId?: string;
  existingSku?: string;
  conflictReason?: string;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function toNullableJsonInput(
  value: Record<string, unknown> | null | undefined,
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

function normalizeCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeSkuSegment(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

function buildCanonicalVariantKey(
  attrs: Array<{ optionId: string; optionValueId: string }>,
): string {
  return [...attrs]
    .sort((a, b) => a.optionId.localeCompare(b.optionId))
    .map((a) => `${a.optionId}:${a.optionValueId}`)
    .join("|");
}

function buildSuggestedSku(
  templateSku: string,
  attrs: MatrixAttributeDescriptor[],
  pattern?: string,
): string {
  const valueCodes = attrs.map((a) => normalizeSkuSegment(a.valueCode));
  let formatted: string;
  if (pattern && pattern.trim().length > 0) {
    formatted = pattern
      .replace(/\{TEMPLATE_SKU\}/gi, templateSku)
      .replace(/\{VALUE_CODES\}/gi, valueCodes.join("-"))
      .replace(/\{OPTION_CODES\}/gi, valueCodes.join("-"));

    for (const attr of attrs) {
      const optRegex = new RegExp(`\\{OPT:${attr.optionCode}\\}`, "gi");
      formatted = formatted.replace(optRegex, normalizeSkuSegment(attr.valueCode));
    }
  } else {
    formatted = `${templateSku}-${valueCodes.join("-")}`;
  }

  const sanitized = formatted
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (sanitized.length <= 64) {
    return sanitized || templateSku;
  }

  // Keep a stable 6-char hash suffix if SKU exceeds 64 chars
  let hash = 0;
  for (let i = 0; i < sanitized.length; i++) {
    hash = (hash * 31 + sanitized.charCodeAt(i)) >>> 0;
  }
  const suffix = hash.toString(36).toUpperCase().slice(0, 6).padStart(6, "0");
  return `${sanitized.slice(0, 57)}-${suffix}`;
}

function buildSuggestedName(
  templateName: string,
  attrs: MatrixAttributeDescriptor[],
  pattern?: string,
): string {
  const labels = attrs.map((a) => a.valueLabel);
  if (pattern && pattern.trim().length > 0) {
    let formatted = pattern
      .replace(/\{TEMPLATE_NAME\}/gi, templateName)
      .replace(/\{VALUE_LABELS\}/gi, labels.join(" / "))
      .replace(/\{OPTION_LABELS\}/gi, labels.join(" / "));
    for (const attr of attrs) {
      const optRegex = new RegExp(`\\{OPT:${attr.optionCode}\\}`, "gi");
      formatted = formatted.replace(optRegex, attr.valueLabel);
    }
    return formatted.trim().slice(0, 200);
  }
  return `${templateName} - ${labels.join(" / ")}`.slice(0, 200);
}

function cartesianProduct<T>(arrays: T[][], maxCombinations: number): T[][] {
  if (arrays.length === 0) return [];
  let total = 1;
  for (const arr of arrays) {
    if (arr.length === 0) return [];
    total *= arr.length;
    if (total > maxCombinations) {
      throw new BadRequestException(
        `Matrix combination count exceeds limit (${maxCombinations}). Narrow your selected option values or raise maxCombinations.`,
      );
    }
  }

  let acc: T[][] = [[]];
  for (const group of arrays) {
    const next: T[][] = [];
    for (const prefix of acc) {
      for (const item of group) {
        next.push([...prefix, item]);
      }
    }
    acc = next;
  }
  return acc;
}

@Injectable()
export class VariantsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
  ) {}

  private resolveVerifiedOrganizationId(tenant: AuthenticatedOrganization): string {
    const contextOrgId = OrganizationContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active organization context mismatch.");
    }
    return tenant.organizationId;
  }

  private async invalidateItemCacheSafe(
    organizationId: string,
    itemId: string,
  ): Promise<void> {
    try {
      await this.redisService.invalidateOrganizationCache(
        organizationId,
        `item:${itemId}`,
      );
    } catch {
      // Non-fatal cache invalidation error
    }
  }

  // ==========================================
  // Reusable Organization Variant Options
  // ==========================================

  async createOption(
    tenant: AuthenticatedOrganization,
    input: CreateVariantOptionInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const code = normalizeCode(input.code);
    if (!code) {
      throw new BadRequestException("Option code must contain alphanumeric characters.");
    }

    const values = input.values ?? [];
    const seenValCodes = new Set<string>();
    const normalizedValues = values.map((v, idx) => {
      const valCode = normalizeCode(v.code);
      if (!valCode) {
        throw new BadRequestException(
          `Option value "${v.code}" must contain alphanumeric characters.`,
        );
      }
      if (seenValCodes.has(valCode)) {
        throw new BadRequestException(
          `Duplicate option value code "${valCode}" in request.`,
        );
      }
      seenValCodes.add(valCode);
      return {
        organizationId,
        code: valCode,
        label: v.label.trim(),
        swatchHex: v.swatchHex?.trim() || null,
        sortOrder: v.sortOrder ?? idx,
        isActive: v.isActive ?? true,
        metadata: toNullableJsonInput(v.metadata),
      };
    });

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        const option = await tx.variantOption.create({
          data: {
            organizationId,
            code,
            name: input.name.trim(),
            displayType: input.displayType ?? VariantOptionDisplayType.SELECT,
            sortOrder: input.sortOrder ?? 0,
            isActive: input.isActive ?? true,
            metadata: toNullableJsonInput(input.metadata),
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
            ...(normalizedValues.length > 0
              ? {
                  values: {
                    create: normalizedValues,
                  },
                }
              : {}),
          },
          include: {
            values: { orderBy: [{ sortOrder: "asc" }, { code: "asc" }] },
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "variant_option.created",
            resourceType: "VariantOption",
            resourceId: option.id,
            metadata: {
              code: option.code,
              name: option.name,
              valueCount: option.values.length,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return option;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Variant option code "${code}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async listOptions(
    tenant: AuthenticatedOrganization,
    query: ListVariantOptionsQuery,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const search = query.search?.trim();

    const options = await this.prismaService.scoped.variantOption.findMany({
      where: {
        organizationId,
        ...(query.displayType ? { displayType: query.displayType } : {}),
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search, mode: "insensitive" } },
                { name: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        values: {
          orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
        },
        _count: {
          select: { templateOptions: true, variantAttributes: true },
        },
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });

    return { organizationId, options };
  }

  async getOption(tenant: AuthenticatedOrganization, optionId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    const option = await this.prismaService.scoped.variantOption.findUnique({
      where: { id: optionId },
      include: {
        values: {
          orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
        },
        _count: {
          select: { templateOptions: true, variantAttributes: true },
        },
      },
    });
    if (!option) {
      throw new NotFoundException("Variant option was not found.");
    }
    return option;
  }

  async updateOption(
    tenant: AuthenticatedOrganization,
    optionId: string,
    input: UpdateVariantOptionInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.variantOption.findFirst({
        where: { id: optionId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Variant option was not found.");
      }

      const updated = await tx.variantOption.update({
        where: { id: optionId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.displayType !== undefined
            ? { displayType: input.displayType }
            : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.metadata !== undefined
            ? { metadata: toNullableJsonInput(input.metadata) }
            : {}),
          updatedByUserId: tenant.userId,
        },
        include: {
          values: { orderBy: [{ sortOrder: "asc" }, { code: "asc" }] },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "variant_option.updated",
          resourceType: "VariantOption",
          resourceId: optionId,
          metadata: { code: updated.code } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async addOptionValues(
    tenant: AuthenticatedOrganization,
    optionId: string,
    values: OptionValueInput[],
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    if (values.length === 0) {
      throw new BadRequestException("At least one option value is required.");
    }

    const seen = new Set<string>();
    const prepared = values.map((v, idx) => {
      const code = normalizeCode(v.code);
      if (!code) {
        throw new BadRequestException(
          `Option value "${v.code}" must contain alphanumeric characters.`,
        );
      }
      if (seen.has(code)) {
        throw new BadRequestException(`Duplicate value code "${code}" in request.`);
      }
      seen.add(code);
      return {
        organizationId,
        optionId,
        code,
        label: v.label.trim(),
        swatchHex: v.swatchHex?.trim() || null,
        sortOrder: v.sortOrder ?? idx,
        isActive: v.isActive ?? true,
        metadata: toNullableJsonInput(v.metadata),
      };
    });

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        const option = await tx.variantOption.findFirst({
          where: { id: optionId, organizationId },
        });
        if (!option) {
          throw new NotFoundException("Variant option was not found.");
        }

        await tx.variantOptionValue.createMany({
          data: prepared,
        });

        const updated = await tx.variantOption.findFirstOrThrow({
          where: { id: optionId, organizationId },
          include: {
            values: { orderBy: [{ sortOrder: "asc" }, { code: "asc" }] },
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "variant_option.values_added",
            resourceType: "VariantOption",
            resourceId: optionId,
            metadata: {
              optionCode: option.code,
              addedCodes: prepared.map((p) => p.code),
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return updated;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          "One or more option value codes already exist on this option.",
        );
      }
      throw error;
    }
  }

  async updateOptionValue(
    tenant: AuthenticatedOrganization,
    optionId: string,
    valueId: string,
    input: UpdateOptionValueInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.variantOptionValue.findFirst({
        where: { id: valueId, optionId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Variant option value was not found.");
      }

      const updated = await tx.variantOptionValue.update({
        where: { id: valueId },
        data: {
          ...(input.label !== undefined ? { label: input.label.trim() } : {}),
          ...(input.swatchHex !== undefined
            ? { swatchHex: input.swatchHex?.trim() || null }
            : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.metadata !== undefined
            ? { metadata: toNullableJsonInput(input.metadata) }
            : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "variant_option_value.updated",
          resourceType: "VariantOptionValue",
          resourceId: valueId,
          metadata: {
            optionId,
            code: updated.code,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  // ==========================================
  // Product Templates & Option Configuration
  // ==========================================

  private async configureTemplateOptionsInTx(
    tx: Prisma.TransactionClient,
    organizationId: string,
    templateId: string,
    options: TemplateOptionConfigInput[],
  ) {
    const seenOptionIds = new Set<string>();
    for (const cfg of options) {
      if (seenOptionIds.has(cfg.optionId)) {
        throw new BadRequestException(
          `Duplicate option (${cfg.optionId}) in template configuration.`,
        );
      }
      seenOptionIds.add(cfg.optionId);
    }

    const existingVariantAttrs = await tx.itemVariantAttribute.findMany({
      where: {
        organizationId,
        variantItem: { parentItemId: templateId },
      },
      select: { optionId: true },
      distinct: ["optionId"],
    });
    for (const used of existingVariantAttrs) {
      if (!seenOptionIds.has(used.optionId)) {
        throw new BadRequestException(
          `Cannot remove option (${used.optionId}) from template while existing variants reference it.`,
        );
      }
    }

    const optionIds = Array.from(seenOptionIds);
    const optionRecords =
      optionIds.length > 0
        ? await tx.variantOption.findMany({
            where: { organizationId, id: { in: optionIds } },
            include: {
              values: {
                where: { isActive: true },
                orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
              },
            },
          })
        : [];
    const optionMap = new Map(optionRecords.map((o) => [o.id, o]));

    for (const cfg of options) {
      const opt = optionMap.get(cfg.optionId);
      if (!opt || !opt.isActive) {
        throw new BadRequestException(
          `Variant option (${cfg.optionId}) was not found or is inactive.`,
        );
      }
      if (cfg.valueIds && cfg.valueIds.length > 0) {
        const validIds = new Set(opt.values.map((v) => v.id));
        for (const vid of cfg.valueIds) {
          if (!validIds.has(vid)) {
            throw new BadRequestException(
              `Option value (${vid}) is invalid or inactive for option "${opt.code}".`,
            );
          }
        }
      }
    }

    await tx.itemTemplateOption.deleteMany({
      where: { organizationId, templateItemId: templateId },
    });

    const createdTemplateOptions = [];
    for (let idx = 0; idx < options.length; idx++) {
      const cfg = options[idx]!;
      const opt = optionMap.get(cfg.optionId)!;
      const chosenValueIds =
        cfg.valueIds && cfg.valueIds.length > 0
          ? Array.from(new Set(cfg.valueIds))
          : opt.values.map((v) => v.id);

      const tplOption = await tx.itemTemplateOption.create({
        data: {
          organizationId,
          templateItemId: templateId,
          optionId: opt.id,
          sortOrder: cfg.sortOrder ?? idx,
          ...(chosenValueIds.length > 0
            ? {
                allowedValues: {
                  create: chosenValueIds.map((vid, vIdx) => ({
                    organizationId,
                    optionValueId: vid,
                    sortOrder: vIdx,
                  })),
                },
              }
            : {}),
        },
        include: {
          option: true,
          allowedValues: {
            orderBy: { sortOrder: "asc" },
            include: { optionValue: true },
          },
        },
      });
      createdTemplateOptions.push(tplOption);
    }

    return createdTemplateOptions;
  }

  async createTemplate(
    tenant: AuthenticatedOrganization,
    input: CreateTemplateInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const normalizedSku = input.sku.trim();
    const normalizedName = input.name.trim();

    try {
      const result = await this.prismaService.raw.$transaction(async (tx) => {
        let resolvedCurrency = input.currency;
        if (!resolvedCurrency) {
          const settings = await tx.organizationSettings.findUnique({
            where: { organizationId },
            select: { defaultCurrency: true },
          });
          resolvedCurrency = settings?.defaultCurrency ?? "USD";
        }

        const template = await tx.item.create({
          data: {
            organizationId,
            sku: normalizedSku,
            name: normalizedName,
            description: input.description ?? null,
            type: input.type,
            status: input.status ?? ItemStatus.ACTIVE,
            unitOfMeasure: input.unitOfMeasure?.trim() || "unit",
            currency: resolvedCurrency,
            salePriceCents: input.salePriceCents ?? 0,
            costPriceCents: input.costPriceCents ?? 0,
            trackInventory: false,
            allowNegativeStock: false,
            reorderPoint: null,
            isBundle: false,
            variantKind: ItemVariantKind.TEMPLATE,
            tags: normalizeTags(input.tags),
            metadata: toNullableJsonInput(input.metadata ?? null),
            version: 1,
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
          },
        });

        const revision = await tx.itemRevision.create({
          data: {
            organizationId,
            itemId: template.id,
            version: 1,
            action: "CREATED",
            changes: {
              sku: { from: null, to: template.sku },
              name: { from: null, to: template.name },
              variantKind: { from: null, to: ItemVariantKind.TEMPLATE },
              salePriceCents: { from: null, to: template.salePriceCents },
              costPriceCents: { from: null, to: template.costPriceCents },
            } as unknown as Prisma.InputJsonValue,
            reason: input.reason ?? null,
            actorUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "variant_template.created",
            resourceType: "Item",
            resourceId: template.id,
            metadata: {
              sku: template.sku,
              name: template.name,
              optionCount: input.options?.length ?? 0,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        const templateOptions =
          input.options && input.options.length > 0
            ? await this.configureTemplateOptionsInTx(
                tx,
                organizationId,
                template.id,
                input.options,
              )
            : [];

        let generatedMatrix: Awaited<
          ReturnType<VariantsService["generateMatrixInTx"]>
        > | null = null;
        if (input.autoGenerateMatrix && templateOptions.length > 0) {
          generatedMatrix = await this.generateMatrixInTx(
            tx,
            organizationId,
            tenant.userId,
            template.id,
            {
              skuPattern: input.skuPattern,
              namePattern: input.namePattern,
              reason: input.reason ?? "Auto-generated during template creation",
            },
            ipAddress,
          );
        }

        return {
          template,
          revision,
          templateOptions,
          generatedMatrix,
        };
      });

      await this.invalidateItemCacheSafe(organizationId, result.template.id);
      if (result.generatedMatrix) {
        for (const v of result.generatedMatrix.createdVariants) {
          await this.invalidateItemCacheSafe(organizationId, v.id);
        }
      }

      return result;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `An item with SKU "${normalizedSku}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async promoteToTemplate(
    tenant: AuthenticatedOrganization,
    itemId: string,
    input: PromoteToTemplateInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.item.findFirst({
        where: { id: itemId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Catalog item was not found.");
      }
      if (existing.status === ItemStatus.ARCHIVED) {
        throw new BadRequestException("Archived items cannot be promoted to templates.");
      }
      if (existing.variantKind === ItemVariantKind.VARIANT) {
        throw new BadRequestException("A variant SKU cannot be promoted to a template.");
      }

      if (existing.variantKind !== ItemVariantKind.TEMPLATE) {
        const [stockCount, lotCount, orderLineCount, poLineCount] =
          await Promise.all([
            tx.stockBalance.count({
              where: {
                organizationId,
                itemId,
                OR: [{ onHandQty: { not: 0 } }, { reservedQty: { not: 0 } }],
              },
            }),
            tx.stockLot.count({ where: { organizationId, itemId } }),
            tx.orderLine.count({ where: { organizationId, itemId } }),
            tx.purchaseOrderLine.count({ where: { organizationId, itemId } }),
          ]);

        if (stockCount + lotCount + orderLineCount + poLineCount > 0) {
          throw new BadRequestException(
            `Item "${existing.sku}" already has stock, lots, or order/purchase history and cannot be converted into an abstract template.`,
          );
        }
      }

      const nextVersion = existing.version + 1;
      const template = await tx.item.update({
        where: { id: itemId },
        data: {
          variantKind: ItemVariantKind.TEMPLATE,
          trackInventory: false,
          allowNegativeStock: false,
          reorderPoint: null,
          version: nextVersion,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.itemRevision.create({
        data: {
          organizationId,
          itemId,
          version: nextVersion,
          action: "UPDATED",
          changes: {
            variantKind: {
              from: existing.variantKind,
              to: ItemVariantKind.TEMPLATE,
            },
            trackInventory: { from: existing.trackInventory, to: false },
          } as unknown as Prisma.InputJsonValue,
          reason: input.reason ?? "Promoted item to product template",
          actorUserId: tenant.userId,
        },
      });

      const templateOptions =
        input.options && input.options.length > 0
          ? await this.configureTemplateOptionsInTx(
              tx,
              organizationId,
              itemId,
              input.options,
            )
          : await tx.itemTemplateOption.findMany({
              where: { organizationId, templateItemId: itemId },
              orderBy: { sortOrder: "asc" },
              include: {
                option: true,
                allowedValues: {
                  orderBy: { sortOrder: "asc" },
                  include: { optionValue: true },
                },
              },
            });

      let generatedMatrix: Awaited<
        ReturnType<VariantsService["generateMatrixInTx"]>
      > | null = null;
      if (input.autoGenerateMatrix && templateOptions.length > 0) {
        generatedMatrix = await this.generateMatrixInTx(
          tx,
          organizationId,
          tenant.userId,
          itemId,
          {
            skuPattern: input.skuPattern,
            namePattern: input.namePattern,
            reason: input.reason ?? "Auto-generated during template promotion",
          },
          ipAddress,
        );
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "variant_template.promoted",
          resourceType: "Item",
          resourceId: itemId,
          metadata: { sku: template.sku } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return { template, templateOptions, generatedMatrix };
    });

    await this.invalidateItemCacheSafe(organizationId, itemId);
    return result;
  }

  async configureTemplateOptions(
    tenant: AuthenticatedOrganization,
    templateId: string,
    options: TemplateOptionConfigInput[],
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const templateOptions = await this.prismaService.raw.$transaction(async (tx) => {
      const template = await tx.item.findFirst({
        where: { id: templateId, organizationId },
      });
      if (!template) {
        throw new NotFoundException("Product template was not found.");
      }
      if (template.variantKind !== ItemVariantKind.TEMPLATE) {
        throw new BadRequestException(
          `Item "${template.sku}" is not a product template.`,
        );
      }
      if (template.status === ItemStatus.ARCHIVED) {
        throw new BadRequestException("Archived templates cannot be modified.");
      }

      const saved = await this.configureTemplateOptionsInTx(
        tx,
        organizationId,
        templateId,
        options,
      );

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "variant_template.options_configured",
          resourceType: "Item",
          resourceId: templateId,
          metadata: {
            templateSku: template.sku,
            optionIds: options.map((o) => o.optionId),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    await this.invalidateItemCacheSafe(organizationId, templateId);
    return { organizationId, templateId, templateOptions };
  }

  async listTemplates(tenant: AuthenticatedOrganization, query: ListTemplatesQuery) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.item.findMany({
      where: {
        organizationId,
        variantKind: ItemVariantKind.TEMPLATE,
        ...(query.type ? { type: query.type } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(search
          ? {
              OR: [
                { sku: { contains: search, mode: "insensitive" } },
                { name: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        templateOptions: {
          orderBy: { sortOrder: "asc" },
          include: {
            option: {
              select: { id: true, code: true, name: true, displayType: true },
            },
            allowedValues: {
              orderBy: { sortOrder: "asc" },
              include: {
                optionValue: {
                  select: {
                    id: true,
                    code: true,
                    label: true,
                    swatchHex: true,
                  },
                },
              },
            },
          },
        },
        variants: {
          select: {
            id: true,
            status: true,
            stockBalances: {
              select: { onHandQty: true, reservedQty: true },
            },
          },
        },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });

    const hasMore = records.length > take;
    const sliced = hasMore ? records.slice(0, take) : records;
    const nextCursor = hasMore ? (sliced[sliced.length - 1]?.id ?? null) : null;

    const templates = sliced.map((tpl) => {
      let totalOnHandQty = 0;
      let totalReservedQty = 0;
      let activeVariantCount = 0;
      for (const v of tpl.variants) {
        if (v.status === ItemStatus.ACTIVE) activeVariantCount++;
        for (const sb of v.stockBalances) {
          totalOnHandQty += sb.onHandQty;
          totalReservedQty += sb.reservedQty;
        }
      }
      const { variants, ...rest } = tpl;
      return {
        ...rest,
        variantCount: variants.length,
        activeVariantCount,
        stockSummary: {
          totalOnHandQty,
          totalReservedQty,
          totalAvailableQty: totalOnHandQty - totalReservedQty,
        },
      };
    });

    return { organizationId, templates, nextCursor };
  }

  async getTemplate(tenant: AuthenticatedOrganization, templateId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const template = await this.prismaService.scoped.item.findFirst({
      where: {
        id: templateId,
        organizationId,
        variantKind: ItemVariantKind.TEMPLATE,
      },
      include: {
        packs: {
          where: { isActive: true },
          orderBy: { unitsPerPack: "asc" },
        },
        templateOptions: {
          orderBy: { sortOrder: "asc" },
          include: {
            option: true,
            allowedValues: {
              orderBy: { sortOrder: "asc" },
              include: { optionValue: true },
            },
          },
        },
        variants: {
          orderBy: { sku: "asc" },
          include: {
            variantAttributes: {
              include: {
                option: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    displayType: true,
                    sortOrder: true,
                  },
                },
                optionValue: {
                  select: {
                    id: true,
                    code: true,
                    label: true,
                    swatchHex: true,
                    sortOrder: true,
                  },
                },
              },
            },
            stockBalances: {
              include: {
                location: {
                  select: { id: true, code: true, name: true, type: true },
                },
              },
            },
            packs: {
              where: { isActive: true },
              orderBy: { unitsPerPack: "asc" },
            },
          },
        },
      },
    });

    if (!template) {
      throw new NotFoundException("Product template was not found.");
    }

    let aggregateOnHandQty = 0;
    let aggregateReservedQty = 0;

    const enrichedVariants = template.variants.map((v) => {
      const effectiveSalePriceCents =
        v.salePriceOverrideCents ??
        (v.inheritParentPricing ? template.salePriceCents : v.salePriceCents);
      const effectiveCostPriceCents =
        v.costPriceOverrideCents ??
        (v.inheritParentPricing ? template.costPriceCents : v.costPriceCents);

      const onHandQty = v.stockBalances.reduce((s, b) => s + b.onHandQty, 0);
      const reservedQty = v.stockBalances.reduce((s, b) => s + b.reservedQty, 0);
      aggregateOnHandQty += onHandQty;
      aggregateReservedQty += reservedQty;

      return {
        ...v,
        effectivePricing: {
          inheritParentPricing: v.inheritParentPricing,
          salePriceCents: effectiveSalePriceCents,
          costPriceCents: effectiveCostPriceCents,
          salePriceInherited:
            v.inheritParentPricing && v.salePriceOverrideCents === null,
          costPriceInherited:
            v.inheritParentPricing && v.costPriceOverrideCents === null,
        },
        stockSummary: {
          onHandQty,
          reservedQty,
          availableQty: onHandQty - reservedQty,
        },
      };
    });

    return {
      organizationId,
      template: {
        ...template,
        variants: enrichedVariants,
        stockSummary: {
          totalOnHandQty: aggregateOnHandQty,
          totalReservedQty: aggregateReservedQty,
          totalAvailableQty: aggregateOnHandQty - aggregateReservedQty,
        },
      },
    };
  }

  // ==========================================
  // Auto SKU Matrix Preview & Generation
  // ==========================================

  private async computeMatrixPreviewInTx(
    tx: Prisma.TransactionClient,
    organizationId: string,
    templateId: string,
    input: PreviewMatrixInput,
  ) {
    const template = await tx.item.findFirst({
      where: {
        id: templateId,
        organizationId,
        variantKind: ItemVariantKind.TEMPLATE,
      },
      include: {
        templateOptions: {
          orderBy: { sortOrder: "asc" },
          include: {
            option: {
              include: {
                values: {
                  where: { isActive: true },
                  orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
                },
              },
            },
            allowedValues: {
              orderBy: { sortOrder: "asc" },
              include: { optionValue: true },
            },
          },
        },
        variants: {
          select: {
            id: true,
            sku: true,
            variantKey: true,
            status: true,
          },
        },
      },
    });

    if (!template) {
      throw new NotFoundException("Product template was not found.");
    }

    const maxCombinations = Math.min(Math.max(input.maxCombinations ?? 250, 1), 500);
    const dimensionLists: MatrixAttributeDescriptor[][] = [];

    if (input.selections && input.selections.length > 0) {
      const seenOptionIds = new Set<string>();
      const optIds = input.selections.map((s) => s.optionId);
      const options = await tx.variantOption.findMany({
        where: { organizationId, id: { in: optIds }, isActive: true },
        include: {
          values: {
            where: { isActive: true },
            orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
          },
        },
      });
      const optMap = new Map(options.map((o) => [o.id, o]));

      for (const sel of input.selections) {
        if (seenOptionIds.has(sel.optionId)) {
          throw new BadRequestException(
            `Duplicate option (${sel.optionId}) in matrix selections.`,
          );
        }
        seenOptionIds.add(sel.optionId);

        const opt = optMap.get(sel.optionId);
        if (!opt) {
          throw new BadRequestException(
            `Variant option (${sel.optionId}) was not found or is inactive.`,
          );
        }
        const selectedVals =
          sel.valueIds && sel.valueIds.length > 0
            ? sel.valueIds.map((vid) => {
                const found = opt.values.find((v) => v.id === vid);
                if (!found) {
                  throw new BadRequestException(
                    `Option value (${vid}) does not belong to option "${opt.code}".`,
                  );
                }
                return found;
              })
            : opt.values;

        if (selectedVals.length === 0) {
          throw new BadRequestException(
            `Variant option "${opt.name}" has no active values for matrix generation.`,
          );
        }

        dimensionLists.push(
          selectedVals.map((val) => ({
            optionId: opt.id,
            optionCode: opt.code,
            optionName: opt.name,
            optionValueId: val.id,
            valueCode: val.code,
            valueLabel: val.label,
            swatchHex: val.swatchHex,
          })),
        );
      }
    } else {
      if (template.templateOptions.length === 0) {
        throw new BadRequestException(
          "Template has no variant options configured. Configure template options or pass selections.",
        );
      }
      for (const tplOpt of template.templateOptions) {
        const vals =
          tplOpt.allowedValues.length > 0
            ? tplOpt.allowedValues
                .map((av) => av.optionValue)
                .filter((v) => v.isActive)
            : tplOpt.option.values;

        if (vals.length === 0) {
          throw new BadRequestException(
            `Template option "${tplOpt.option.name}" has no active values configured.`,
          );
        }

        dimensionLists.push(
          vals.map((val) => ({
            optionId: tplOpt.option.id,
            optionCode: tplOpt.option.code,
            optionName: tplOpt.option.name,
            optionValueId: val.id,
            valueCode: val.code,
            valueLabel: val.label,
            swatchHex: val.swatchHex,
          })),
        );
      }
    }

    const combinations = cartesianProduct(dimensionLists, maxCombinations);
    const existingByKey = new Map(
      template.variants
        .filter((v) => v.variantKey)
        .map((v) => [v.variantKey!, v]),
    );

    const candidateSkus = combinations.map((attrs) =>
      buildSuggestedSku(template.sku, attrs, input.skuPattern),
    );
    const collidingItems =
      candidateSkus.length > 0
        ? await tx.item.findMany({
            where: {
              organizationId,
              sku: { in: Array.from(new Set(candidateSkus)) },
            },
            select: { id: true, sku: true, parentItemId: true },
          })
        : [];
    const existingSkuMap = new Map(collidingItems.map((i) => [i.sku, i]));
    const seenDraftSkus = new Set<string>();

    const entries: MatrixPreviewEntry[] = combinations.map((attrs, idx) => {
      const variantKey = buildCanonicalVariantKey(attrs);
      const suggestedSku = candidateSkus[idx]!;
      const suggestedName = buildSuggestedName(
        template.name,
        attrs,
        input.namePattern,
      );

      const existingVariant = existingByKey.get(variantKey);
      if (existingVariant) {
        return {
          variantKey,
          attributes: attrs,
          suggestedSku,
          suggestedName,
          status: "EXISTING",
          existingItemId: existingVariant.id,
          existingSku: existingVariant.sku,
        };
      }

      const skuOwner = existingSkuMap.get(suggestedSku);
      if (skuOwner) {
        return {
          variantKey,
          attributes: attrs,
          suggestedSku,
          suggestedName,
          status: "CONFLICT",
          conflictReason: `SKU "${suggestedSku}" already belongs to item (${skuOwner.id}).`,
        };
      }

      if (seenDraftSkus.has(suggestedSku)) {
        return {
          variantKey,
          attributes: attrs,
          suggestedSku,
          suggestedName,
          status: "CONFLICT",
          conflictReason: `Duplicate generated SKU "${suggestedSku}" within matrix batch.`,
        };
      }
      seenDraftSkus.add(suggestedSku);

      return {
        variantKey,
        attributes: attrs,
        suggestedSku,
        suggestedName,
        status: "CREATE",
      };
    });

    const toCreateCount = entries.filter((e) => e.status === "CREATE").length;
    const existingCount = entries.filter((e) => e.status === "EXISTING").length;
    const conflictCount = entries.filter((e) => e.status === "CONFLICT").length;

    return {
      organizationId,
      templateId: template.id,
      templateSku: template.sku,
      templateName: template.name,
      summary: {
        totalCombinations: entries.length,
        toCreateCount,
        existingCount,
        conflictCount,
      },
      entries,
    };
  }

  async previewMatrix(
    tenant: AuthenticatedOrganization,
    templateId: string,
    input: PreviewMatrixInput,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    return this.prismaService.raw.$transaction((tx) =>
      this.computeMatrixPreviewInTx(tx, organizationId, templateId, input),
    );
  }

  private async generateMatrixInTx(
    tx: Prisma.TransactionClient,
    organizationId: string,
    actorUserId: string,
    templateId: string,
    input: GenerateMatrixInput,
    ipAddress?: string,
  ) {
    const template = await tx.item.findFirst({
      where: {
        id: templateId,
        organizationId,
        variantKind: ItemVariantKind.TEMPLATE,
      },
    });
    if (!template) {
      throw new NotFoundException("Product template was not found.");
    }
    if (template.status === ItemStatus.ARCHIVED) {
      throw new BadRequestException(
        "Cannot generate variants on an archived template.",
      );
    }

    const preview = await this.computeMatrixPreviewInTx(
      tx,
      organizationId,
      templateId,
      input,
    );

    const conflicts = preview.entries.filter((e) => e.status === "CONFLICT");
    if (conflicts.length > 0 && !input.skipConflicts) {
      throw new ConflictException(
        `Matrix generation has ${conflicts.length} SKU conflict(s), starting with: ${conflicts[0]!.conflictReason}`,
      );
    }

    const createdVariants = [];
    const overridesMap = input.overridesByVariantKey ?? {};

    for (const entry of preview.entries) {
      if (entry.status !== "CREATE") {
        continue;
      }

      const ov = overridesMap[entry.variantKey];
      const sku = ov?.sku?.trim() || entry.suggestedSku;
      const name = ov?.name?.trim() || entry.suggestedName;
      const inheritParentPricing = ov?.inheritParentPricing ?? true;
      const salePriceOverrideCents = ov?.salePriceOverrideCents ?? null;
      const costPriceOverrideCents = ov?.costPriceOverrideCents ?? null;
      const effectiveSalePrice =
        salePriceOverrideCents ??
        (inheritParentPricing ? template.salePriceCents : 0);
      const effectiveCostPrice =
        costPriceOverrideCents ??
        (inheritParentPricing ? template.costPriceCents : 0);

      const trackInventory =
        ov?.trackInventory ??
        input.defaultTrackInventory ??
        template.type !== ItemType.SERVICE;

      const allowNegativeStock = trackInventory
        ? (ov?.allowNegativeStock ?? input.defaultAllowNegativeStock ?? false)
        : false;
      const reorderPoint = trackInventory
        ? (ov?.reorderPoint !== undefined
            ? ov.reorderPoint
            : (input.defaultReorderPoint ?? null))
        : null;

      const variant = await tx.item.create({
        data: {
          organizationId,
          sku,
          name,
          description: template.description,
          type: template.type,
          status: ov?.status ?? input.defaultStatus ?? ItemStatus.ACTIVE,
          unitOfMeasure: template.unitOfMeasure,
          currency: template.currency,
          salePriceCents: effectiveSalePrice,
          costPriceCents: effectiveCostPrice,
          trackInventory,
          allowNegativeStock,
          reorderPoint,
          isBundle: false,
          variantKind: ItemVariantKind.VARIANT,
          parentItemId: template.id,
          variantKey: entry.variantKey,
          inheritParentPricing,
          salePriceOverrideCents,
          costPriceOverrideCents,
          tags: template.tags,
          metadata: toNullableJsonInput(
            (template.metadata as Record<string, unknown> | null) ?? null,
          ),
          version: 1,
          createdByUserId: actorUserId,
          updatedByUserId: actorUserId,
          variantAttributes: {
            create: entry.attributes.map((attr) => ({
              organizationId,
              optionId: attr.optionId,
              optionValueId: attr.optionValueId,
            })),
          },
        },
        include: {
          variantAttributes: {
            include: {
              option: {
                select: { id: true, code: true, name: true, displayType: true },
              },
              optionValue: {
                select: { id: true, code: true, label: true, swatchHex: true },
              },
            },
          },
        },
      });

      await tx.itemRevision.create({
        data: {
          organizationId,
          itemId: variant.id,
          version: 1,
          action: "CREATED",
          changes: {
            sku: { from: null, to: variant.sku },
            name: { from: null, to: variant.name },
            parentItemId: { from: null, to: template.id },
            variantKey: { from: null, to: entry.variantKey },
            salePriceCents: { from: null, to: variant.salePriceCents },
          } as unknown as Prisma.InputJsonValue,
          reason: input.reason ?? "Generated from template SKU matrix",
          actorUserId,
        },
      });

      createdVariants.push(variant);
    }

    await tx.auditLog.create({
      data: {
        organizationId,
        actorUserId,
        action: "variant_template.matrix_generated",
        resourceType: "Item",
        resourceId: templateId,
        metadata: {
          templateSku: template.sku,
          createdCount: createdVariants.length,
          existingSkippedCount: preview.summary.existingCount,
          conflictSkippedCount: conflicts.length,
        } as Prisma.InputJsonValue,
        ipAddress: ipAddress ?? null,
      },
    });

    return {
      organizationId,
      templateId,
      createdCount: createdVariants.length,
      existingSkippedCount: preview.summary.existingCount,
      conflictSkippedCount: input.skipConflicts ? conflicts.length : 0,
      createdVariants,
    };
  }

  async generateMatrix(
    tenant: AuthenticatedOrganization,
    templateId: string,
    input: GenerateMatrixInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    try {
      const result = await this.prismaService.raw.$transaction((tx) =>
        this.generateMatrixInTx(
          tx,
          organizationId,
          tenant.userId,
          templateId,
          input,
          ipAddress,
        ),
      );

      await this.invalidateItemCacheSafe(organizationId, templateId);
      for (const v of result.createdVariants) {
        await this.invalidateItemCacheSafe(organizationId, v.id);
      }

      return result;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          "One or more generated variant SKUs or option combinations already exist.",
        );
      }
      throw error;
    }
  }

  // ==========================================
  // Individual & Bulk Variant Operations
  // ==========================================

  private async resolveAttributeInputsInTx(
    tx: Prisma.TransactionClient,
    organizationId: string,
    attributes: VariantAttributeInput[],
  ): Promise<MatrixAttributeDescriptor[]> {
    if (attributes.length === 0) {
      throw new BadRequestException("At least one variant attribute is required.");
    }

    const allOptions = await tx.variantOption.findMany({
      where: { organizationId },
      include: { values: true },
    });

    const byOptionId = new Map(allOptions.map((o) => [o.id, o]));
    const byOptionCode = new Map(allOptions.map((o) => [o.code, o]));
    const seenOptionIds = new Set<string>();
    const resolved: MatrixAttributeDescriptor[] = [];

    for (const attr of attributes) {
      const opt = attr.optionId
        ? byOptionId.get(attr.optionId)
        : attr.optionCode
          ? byOptionCode.get(normalizeCode(attr.optionCode))
          : undefined;

      if (!opt || !opt.isActive) {
        throw new BadRequestException(
          `Variant option "${attr.optionId ?? attr.optionCode ?? "unknown"}" was not found or is inactive.`,
        );
      }
      if (seenOptionIds.has(opt.id)) {
        throw new BadRequestException(
          `Duplicate option "${opt.code}" in variant attributes.`,
        );
      }
      seenOptionIds.add(opt.id);

      const val = attr.optionValueId
        ? opt.values.find((v) => v.id === attr.optionValueId)
        : attr.valueCode
          ? opt.values.find((v) => v.code === normalizeCode(attr.valueCode!))
          : undefined;

      if (!val || !val.isActive) {
        throw new BadRequestException(
          `Option value "${attr.optionValueId ?? attr.valueCode ?? "unknown"}" was not found or is inactive for option "${opt.code}".`,
        );
      }

      resolved.push({
        optionId: opt.id,
        optionCode: opt.code,
        optionName: opt.name,
        optionValueId: val.id,
        valueCode: val.code,
        valueLabel: val.label,
        swatchHex: val.swatchHex,
      });
    }

    return resolved;
  }

  async createVariant(
    tenant: AuthenticatedOrganization,
    templateId: string,
    input: CreateVariantInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    try {
      const variant = await this.prismaService.raw.$transaction(async (tx) => {
        const template = await tx.item.findFirst({
          where: {
            id: templateId,
            organizationId,
            variantKind: ItemVariantKind.TEMPLATE,
          },
          include: {
            templateOptions: { orderBy: { sortOrder: "asc" } },
          },
        });
        if (!template) {
          throw new NotFoundException("Product template was not found.");
        }
        if (template.status === ItemStatus.ARCHIVED) {
          throw new BadRequestException(
            "Cannot create variants under an archived template.",
          );
        }

        const resolvedAttrs = await this.resolveAttributeInputsInTx(
          tx,
          organizationId,
          input.attributes,
        );

        if (template.templateOptions.length > 0) {
          const requiredIds = new Set(
            template.templateOptions.map((o) => o.optionId),
          );
          const providedIds = new Set(resolvedAttrs.map((a) => a.optionId));
          for (const reqId of requiredIds) {
            if (!providedIds.has(reqId)) {
              throw new BadRequestException(
                `Variant must specify a value for all configured template options (missing option ${reqId}).`,
              );
            }
          }
          for (const provId of providedIds) {
            if (!requiredIds.has(provId)) {
              throw new BadRequestException(
                `Option (${provId}) is not configured on template "${template.sku}".`,
              );
            }
          }
        }

        const variantKey = buildCanonicalVariantKey(resolvedAttrs);
        const sku =
          input.sku?.trim() || buildSuggestedSku(template.sku, resolvedAttrs);
        const name =
          input.name?.trim() || buildSuggestedName(template.name, resolvedAttrs);

        const inheritParentPricing = input.inheritParentPricing ?? true;
        const salePriceOverrideCents = input.salePriceOverrideCents ?? null;
        const costPriceOverrideCents = input.costPriceOverrideCents ?? null;
        const effectiveSalePrice =
          salePriceOverrideCents ??
          (inheritParentPricing ? template.salePriceCents : 0);
        const effectiveCostPrice =
          costPriceOverrideCents ??
          (inheritParentPricing ? template.costPriceCents : 0);

        const trackInventory =
          input.trackInventory ?? template.type !== ItemType.SERVICE;
        if (!trackInventory) {
          if (input.allowNegativeStock === true) {
            throw new BadRequestException(
              "allowNegativeStock cannot be enabled when trackInventory is false.",
            );
          }
          if (input.reorderPoint !== undefined && input.reorderPoint !== null) {
            throw new BadRequestException(
              "reorderPoint cannot be set when trackInventory is false.",
            );
          }
        }

        const created = await tx.item.create({
          data: {
            organizationId,
            sku,
            name,
            description:
              input.description !== undefined
                ? input.description
                : template.description,
            type: template.type,
            status: input.status ?? ItemStatus.ACTIVE,
            unitOfMeasure: template.unitOfMeasure,
            currency: template.currency,
            salePriceCents: effectiveSalePrice,
            costPriceCents: effectiveCostPrice,
            trackInventory,
            allowNegativeStock: trackInventory
              ? (input.allowNegativeStock ?? false)
              : false,
            reorderPoint: trackInventory ? (input.reorderPoint ?? null) : null,
            isBundle: false,
            variantKind: ItemVariantKind.VARIANT,
            parentItemId: template.id,
            variantKey,
            inheritParentPricing,
            salePriceOverrideCents,
            costPriceOverrideCents,
            tags:
              input.tags !== undefined ? normalizeTags(input.tags) : template.tags,
            metadata: toNullableJsonInput(
              input.metadata !== undefined
                ? input.metadata
                : ((template.metadata as Record<string, unknown> | null) ?? null),
            ),
            version: 1,
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
            variantAttributes: {
              create: resolvedAttrs.map((a) => ({
                organizationId,
                optionId: a.optionId,
                optionValueId: a.optionValueId,
              })),
            },
          },
          include: {
            variantAttributes: {
              include: {
                option: {
                  select: { id: true, code: true, name: true, displayType: true },
                },
                optionValue: {
                  select: { id: true, code: true, label: true, swatchHex: true },
                },
              },
            },
          },
        });

        await tx.itemRevision.create({
          data: {
            organizationId,
            itemId: created.id,
            version: 1,
            action: "CREATED",
            changes: {
              sku: { from: null, to: created.sku },
              parentItemId: { from: null, to: template.id },
              variantKey: { from: null, to: variantKey },
            } as unknown as Prisma.InputJsonValue,
            reason: input.reason ?? null,
            actorUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "variant.created",
            resourceType: "Item",
            resourceId: created.id,
            metadata: {
              templateId: template.id,
              sku: created.sku,
              variantKey,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });

      await this.invalidateItemCacheSafe(organizationId, templateId);
      await this.invalidateItemCacheSafe(organizationId, variant.id);
      return variant;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          "A variant with that SKU or option combination already exists.",
        );
      }
      throw error;
    }
  }

  async resolveByAttributes(
    tenant: AuthenticatedOrganization,
    templateId: string,
    input: ResolveVariantByAttributesInput,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const template = await this.prismaService.scoped.item.findFirst({
      where: {
        id: templateId,
        organizationId,
        variantKind: ItemVariantKind.TEMPLATE,
      },
    });
    if (!template) {
      throw new NotFoundException("Product template was not found.");
    }

    const resolvedAttrs = await this.prismaService.raw.$transaction((tx) =>
      this.resolveAttributeInputsInTx(tx, organizationId, input.attributes),
    );
    const variantKey = buildCanonicalVariantKey(resolvedAttrs);

    const variant = await this.prismaService.scoped.item.findFirst({
      where: {
        organizationId,
        parentItemId: templateId,
        variantKey,
        variantKind: ItemVariantKind.VARIANT,
      },
      include: {
        variantAttributes: {
          include: {
            option: {
              select: { id: true, code: true, name: true, displayType: true },
            },
            optionValue: {
              select: { id: true, code: true, label: true, swatchHex: true },
            },
          },
        },
        stockBalances: {
          include: {
            location: { select: { id: true, code: true, name: true, type: true } },
          },
        },
        packs: { where: { isActive: true } },
      },
    });

    if (!variant) {
      throw new NotFoundException(
        `No variant found on template "${template.sku}" matching the provided attributes.`,
      );
    }

    const effectiveSalePriceCents =
      variant.salePriceOverrideCents ??
      (variant.inheritParentPricing
        ? template.salePriceCents
        : variant.salePriceCents);
    const effectiveCostPriceCents =
      variant.costPriceOverrideCents ??
      (variant.inheritParentPricing
        ? template.costPriceCents
        : variant.costPriceCents);

    return {
      organizationId,
      template: { id: template.id, sku: template.sku, name: template.name },
      variant: {
        ...variant,
        effectivePricing: {
          inheritParentPricing: variant.inheritParentPricing,
          salePriceCents: effectiveSalePriceCents,
          costPriceCents: effectiveCostPriceCents,
          salePriceInherited:
            variant.inheritParentPricing && variant.salePriceOverrideCents === null,
          costPriceInherited:
            variant.inheritParentPricing && variant.costPriceOverrideCents === null,
        },
      },
    };
  }

  async getVariant(tenant: AuthenticatedOrganization, variantId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const variant = await this.prismaService.scoped.item.findFirst({
      where: {
        id: variantId,
        organizationId,
        variantKind: ItemVariantKind.VARIANT,
      },
      include: {
        parentItem: {
          include: {
            packs: { where: { isActive: true }, orderBy: { unitsPerPack: "asc" } },
          },
        },
        variantAttributes: {
          include: {
            option: {
              select: { id: true, code: true, name: true, displayType: true },
            },
            optionValue: {
              select: { id: true, code: true, label: true, swatchHex: true },
            },
          },
        },
        packs: { where: { isActive: true }, orderBy: { unitsPerPack: "asc" } },
        stockBalances: {
          include: {
            location: { select: { id: true, code: true, name: true, type: true } },
          },
        },
      },
    });

    if (!variant) {
      throw new NotFoundException("Product variant was not found.");
    }

    const parent = variant.parentItem;
    const effectiveSalePriceCents =
      variant.salePriceOverrideCents ??
      (variant.inheritParentPricing && parent
        ? parent.salePriceCents
        : variant.salePriceCents);
    const effectiveCostPriceCents =
      variant.costPriceOverrideCents ??
      (variant.inheritParentPricing && parent
        ? parent.costPriceCents
        : variant.costPriceCents);

    const ownPackCodes = new Set(variant.packs.map((p) => p.code));
    const inheritedPacks =
      parent?.packs.filter((p) => !ownPackCodes.has(p.code)) ?? [];

    return {
      organizationId,
      variant,
      effectivePricing: {
        inheritParentPricing: variant.inheritParentPricing,
        salePriceCents: effectiveSalePriceCents,
        costPriceCents: effectiveCostPriceCents,
        salePriceInherited:
          Boolean(parent) &&
          variant.inheritParentPricing &&
          variant.salePriceOverrideCents === null,
        costPriceInherited:
          Boolean(parent) &&
          variant.inheritParentPricing &&
          variant.costPriceOverrideCents === null,
      },
      inheritedPacks,
    };
  }

  async updateVariant(
    tenant: AuthenticatedOrganization,
    variantId: string,
    input: UpdateVariantInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    try {
      const updated = await this.prismaService.raw.$transaction(async (tx) => {
        const existing = await tx.item.findFirst({
          where: {
            id: variantId,
            organizationId,
            variantKind: ItemVariantKind.VARIANT,
          },
          include: { parentItem: true },
        });
        if (!existing) {
          throw new NotFoundException("Product variant was not found.");
        }
        if (existing.status === ItemStatus.ARCHIVED) {
          throw new BadRequestException(
            "Archived variants cannot be edited directly. Restore the variant first.",
          );
        }
        if (
          input.expectedVersion !== undefined &&
          existing.version !== input.expectedVersion
        ) {
          throw new ConflictException(
            `Version mismatch: expected ${input.expectedVersion}, current is ${existing.version}.`,
          );
        }

        const nextInherit =
          input.inheritParentPricing !== undefined
            ? input.inheritParentPricing
            : existing.inheritParentPricing;
        const nextSaleOverride =
          input.salePriceOverrideCents !== undefined
            ? input.salePriceOverrideCents
            : existing.salePriceOverrideCents;
        const nextCostOverride =
          input.costPriceOverrideCents !== undefined
            ? input.costPriceOverrideCents
            : existing.costPriceOverrideCents;

        const nextEffectiveSale =
          nextSaleOverride ??
          (nextInherit && existing.parentItem
            ? existing.parentItem.salePriceCents
            : existing.salePriceCents);
        const nextEffectiveCost =
          nextCostOverride ??
          (nextInherit && existing.parentItem
            ? existing.parentItem.costPriceCents
            : existing.costPriceCents);

        const nextTrackInventory =
          input.trackInventory !== undefined
            ? input.trackInventory
            : existing.trackInventory;
        if (!nextTrackInventory) {
          if (input.allowNegativeStock === true) {
            throw new BadRequestException(
              "allowNegativeStock cannot be enabled when trackInventory is false.",
            );
          }
          if (input.reorderPoint !== undefined && input.reorderPoint !== null) {
            throw new BadRequestException(
              "reorderPoint cannot be set when trackInventory is false.",
            );
          }
        }

        const nextVersion = existing.version + 1;
        const updatedCount = await tx.item.updateMany({
          where: {
            id: variantId,
            organizationId,
            version: existing.version,
          },
          data: {
            ...(input.sku !== undefined ? { sku: input.sku.trim() } : {}),
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.tags !== undefined
              ? { tags: normalizeTags(input.tags) }
              : {}),
            ...(input.metadata !== undefined
              ? { metadata: toNullableJsonInput(input.metadata) }
              : {}),
            trackInventory: nextTrackInventory,
            allowNegativeStock: nextTrackInventory
              ? (input.allowNegativeStock ?? existing.allowNegativeStock)
              : false,
            reorderPoint: nextTrackInventory
              ? (input.reorderPoint !== undefined
                  ? input.reorderPoint
                  : existing.reorderPoint)
              : null,
            inheritParentPricing: nextInherit,
            salePriceOverrideCents: nextSaleOverride,
            costPriceOverrideCents: nextCostOverride,
            salePriceCents: nextEffectiveSale,
            costPriceCents: nextEffectiveCost,
            version: nextVersion,
            updatedByUserId: tenant.userId,
          },
        });

        if (updatedCount.count !== 1) {
          throw new ConflictException(
            "Product variant was updated concurrently. Refresh and retry.",
          );
        }

        const item = await tx.item.findFirstOrThrow({
          where: { id: variantId, organizationId },
          include: {
            variantAttributes: {
              include: {
                option: {
                  select: { id: true, code: true, name: true, displayType: true },
                },
                optionValue: {
                  select: { id: true, code: true, label: true, swatchHex: true },
                },
              },
            },
          },
        });

        await tx.itemRevision.create({
          data: {
            organizationId,
            itemId: variantId,
            version: nextVersion,
            action: "UPDATED",
            changes: {
              inheritParentPricing: {
                from: existing.inheritParentPricing,
                to: nextInherit,
              },
              salePriceOverrideCents: {
                from: existing.salePriceOverrideCents,
                to: nextSaleOverride,
              },
              costPriceOverrideCents: {
                from: existing.costPriceOverrideCents,
                to: nextCostOverride,
              },
              salePriceCents: {
                from: existing.salePriceCents,
                to: nextEffectiveSale,
              },
            } as unknown as Prisma.InputJsonValue,
            reason: input.reason ?? null,
            actorUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "variant.updated",
            resourceType: "Item",
            resourceId: variantId,
            metadata: {
              sku: item.sku,
              version: nextVersion,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return item;
      });

      await this.invalidateItemCacheSafe(organizationId, variantId);
      return updated;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `An item with SKU "${input.sku?.trim()}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async bulkUpdateVariants(
    tenant: AuthenticatedOrganization,
    templateId: string,
    input: BulkUpdateVariantsInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const uniqueIds = Array.from(new Set(input.variantIds));
    if (uniqueIds.length === 0) {
      throw new BadRequestException("At least one variantId is required.");
    }

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const template = await tx.item.findFirst({
        where: {
          id: templateId,
          organizationId,
          variantKind: ItemVariantKind.TEMPLATE,
        },
      });
      if (!template) {
        throw new NotFoundException("Product template was not found.");
      }

      const variants = await tx.item.findMany({
        where: {
          organizationId,
          parentItemId: templateId,
          variantKind: ItemVariantKind.VARIANT,
          id: { in: uniqueIds },
        },
      });
      if (variants.length !== uniqueIds.length) {
        throw new BadRequestException(
          "One or more variantIds do not belong to the specified template.",
        );
      }

      const results = [];
      for (const existing of variants) {
        if (existing.status === ItemStatus.ARCHIVED) {
          throw new BadRequestException(
            `Archived variant "${existing.sku}" cannot be bulk updated.`,
          );
        }

        const nextInherit =
          input.inheritParentPricing !== undefined
            ? input.inheritParentPricing
            : existing.inheritParentPricing;
        const nextSaleOverride =
          input.salePriceOverrideCents !== undefined
            ? input.salePriceOverrideCents
            : existing.salePriceOverrideCents;
        const nextCostOverride =
          input.costPriceOverrideCents !== undefined
            ? input.costPriceOverrideCents
            : existing.costPriceOverrideCents;
        const nextEffectiveSale =
          nextSaleOverride ??
          (nextInherit ? template.salePriceCents : existing.salePriceCents);
        const nextEffectiveCost =
          nextCostOverride ??
          (nextInherit ? template.costPriceCents : existing.costPriceCents);

        const nextVersion = existing.version + 1;
        const item = await tx.item.update({
          where: { id: existing.id },
          data: {
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(existing.trackInventory && input.allowNegativeStock !== undefined
              ? { allowNegativeStock: input.allowNegativeStock }
              : {}),
            ...(existing.trackInventory && input.reorderPoint !== undefined
              ? { reorderPoint: input.reorderPoint }
              : {}),
            inheritParentPricing: nextInherit,
            salePriceOverrideCents: nextSaleOverride,
            costPriceOverrideCents: nextCostOverride,
            salePriceCents: nextEffectiveSale,
            costPriceCents: nextEffectiveCost,
            version: nextVersion,
            updatedByUserId: tenant.userId,
          },
        });

        await tx.itemRevision.create({
          data: {
            organizationId,
            itemId: existing.id,
            version: nextVersion,
            action: "UPDATED",
            changes: {
              salePriceOverrideCents: {
                from: existing.salePriceOverrideCents,
                to: nextSaleOverride,
              },
              costPriceOverrideCents: {
                from: existing.costPriceOverrideCents,
                to: nextCostOverride,
              },
            } as unknown as Prisma.InputJsonValue,
            reason: input.reason ?? "Bulk variant update",
            actorUserId: tenant.userId,
          },
        });

        results.push(item);
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "variant.bulk_updated",
          resourceType: "Item",
          resourceId: templateId,
          metadata: {
            updatedCount: results.length,
            variantIds: uniqueIds,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return results;
    });

    for (const v of updated) {
      await this.invalidateItemCacheSafe(organizationId, v.id);
    }

    return {
      organizationId,
      templateId,
      updatedCount: updated.length,
      variants: updated,
    };
  }
}
