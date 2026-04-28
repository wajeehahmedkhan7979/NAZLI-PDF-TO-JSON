-- Pipeline v2 Migration
-- Adds: DocumentGroup model, new processing stages, new document types,
-- pipeline versioning fields, and GlossaryEntry table.

-- 1. Add new enum values
ALTER TYPE "ProcessingStage" ADD VALUE IF NOT EXISTS 'UNDERSTOOD';
ALTER TYPE "ProcessingStage" ADD VALUE IF NOT EXISTS 'SEGMENTED';
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'PURCHASE';
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'BILLING';
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'MIXED';

-- 2. Add pipeline versioning to documents
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "pipeline_version" TEXT;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "extraction_engine_version" TEXT;

-- 3. Create document_groups table
CREATE TABLE IF NOT EXISTS "document_groups" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "group_index" INTEGER NOT NULL,
    "group_type" TEXT NOT NULL,
    "page_start" INTEGER NOT NULL,
    "page_end" INTEGER NOT NULL,
    "identifiers" JSONB,
    "confidence" DOUBLE PRECISION,
    "canonical_json" JSONB,
    "signals" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_groups_pkey" PRIMARY KEY ("id")
);

-- 4. Add foreign key and index
ALTER TABLE "document_groups" DROP CONSTRAINT IF EXISTS "document_groups_document_id_fkey";
ALTER TABLE "document_groups" ADD CONSTRAINT "document_groups_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "document_groups_document_id_idx" ON "document_groups"("document_id");

-- 5. Create glossary_entries table if not exists
CREATE TABLE IF NOT EXISTS "glossary_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "category" TEXT NOT NULL,
    "japanese" TEXT NOT NULL,
    "english" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "glossary_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "glossary_entries_tenant_id_category_japanese_key"
    ON "glossary_entries"("tenant_id", "category", "japanese");
CREATE INDEX IF NOT EXISTS "glossary_entries_category_idx" ON "glossary_entries"("category");
CREATE INDEX IF NOT EXISTS "glossary_entries_japanese_idx" ON "glossary_entries"("japanese");
