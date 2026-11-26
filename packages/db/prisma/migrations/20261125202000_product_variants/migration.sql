-- CreateEnum
CREATE TYPE "ItemVariantKind" AS ENUM ('STANDARD', 'TEMPLATE', 'VARIANT');

-- CreateEnum
CREATE TYPE "VariantOptionDisplayType" AS ENUM ('SELECT', 'COLOR', 'SIZE', 'TEXT');

-- AlterTable
ALTER TABLE "item"
ADD COLUMN "variantKind" "ItemVariantKind" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN "parentItemId" TEXT,
ADD COLUMN "variantKey" TEXT,
ADD COLUMN "inheritParentPricing" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "salePriceOverrideCents" INTEGER,
ADD COLUMN "costPriceOverrideCents" INTEGER;

-- CreateTable
CREATE TABLE "variant_option" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayType" "VariantOptionDisplayType" NOT NULL DEFAULT 'SELECT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variant_option_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_option_value" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "swatchHex" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variant_option_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_template_option" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "templateItemId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_template_option_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_template_option_value" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "templateOptionId" TEXT NOT NULL,
    "optionValueId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_template_option_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_variant_attribute" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "variantItemId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "optionValueId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_variant_attribute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "item_organizationId_parentItemId_variantKey_key" ON "item"("organizationId", "parentItemId", "variantKey");
CREATE INDEX "item_organizationId_variantKind_status_idx" ON "item"("organizationId", "variantKind", "status");
CREATE INDEX "item_organizationId_parentItemId_idx" ON "item"("organizationId", "parentItemId");

CREATE UNIQUE INDEX "variant_option_organizationId_code_key" ON "variant_option"("organizationId", "code");
CREATE INDEX "variant_option_organizationId_isActive_sortOrder_idx" ON "variant_option"("organizationId", "isActive", "sortOrder");

CREATE UNIQUE INDEX "variant_option_value_organizationId_optionId_code_key" ON "variant_option_value"("organizationId", "optionId", "code");
CREATE INDEX "variant_option_value_organizationId_optionId_sortOrder_idx" ON "variant_option_value"("organizationId", "optionId", "sortOrder");

CREATE UNIQUE INDEX "item_template_option_organizationId_templateItemId_optionId_key" ON "item_template_option"("organizationId", "templateItemId", "optionId");
CREATE INDEX "item_template_option_organizationId_templateItemId_sortOrder_idx" ON "item_template_option"("organizationId", "templateItemId", "sortOrder");

CREATE UNIQUE INDEX "item_template_option_value_organizationId_templateOptionId_optionValueId_key" ON "item_template_option_value"("organizationId", "templateOptionId", "optionValueId");
CREATE INDEX "item_template_option_value_organizationId_templateOptionId_sortOrder_idx" ON "item_template_option_value"("organizationId", "templateOptionId", "sortOrder");

CREATE UNIQUE INDEX "item_variant_attribute_organizationId_variantItemId_optionId_key" ON "item_variant_attribute"("organizationId", "variantItemId", "optionId");
CREATE INDEX "item_variant_attribute_organizationId_optionId_optionValueId_idx" ON "item_variant_attribute"("organizationId", "optionId", "optionValueId");
CREATE INDEX "item_variant_attribute_organizationId_variantItemId_idx" ON "item_variant_attribute"("organizationId", "variantItemId");

-- AddForeignKey
ALTER TABLE "item" ADD CONSTRAINT "item_parentItemId_fkey" FOREIGN KEY ("parentItemId") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "variant_option" ADD CONSTRAINT "variant_option_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "variant_option_value" ADD CONSTRAINT "variant_option_value_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_option_value" ADD CONSTRAINT "variant_option_value_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "variant_option"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "item_template_option" ADD CONSTRAINT "item_template_option_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "item_template_option" ADD CONSTRAINT "item_template_option_templateItemId_fkey" FOREIGN KEY ("templateItemId") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "item_template_option" ADD CONSTRAINT "item_template_option_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "variant_option"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "item_template_option_value" ADD CONSTRAINT "item_template_option_value_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "item_template_option_value" ADD CONSTRAINT "item_template_option_value_templateOptionId_fkey" FOREIGN KEY ("templateOptionId") REFERENCES "item_template_option"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "item_template_option_value" ADD CONSTRAINT "item_template_option_value_optionValueId_fkey" FOREIGN KEY ("optionValueId") REFERENCES "variant_option_value"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "item_variant_attribute" ADD CONSTRAINT "item_variant_attribute_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "item_variant_attribute" ADD CONSTRAINT "item_variant_attribute_variantItemId_fkey" FOREIGN KEY ("variantItemId") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "item_variant_attribute" ADD CONSTRAINT "item_variant_attribute_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "variant_option"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "item_variant_attribute" ADD CONSTRAINT "item_variant_attribute_optionValueId_fkey" FOREIGN KEY ("optionValueId") REFERENCES "variant_option_value"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
