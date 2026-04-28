import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ClassifierService } from '../classifier/classifier.service';
import { ExtractionService } from '../extraction/extraction.service';
import { UnderstandingService } from '../understanding/understanding.service';
import { SegmentationService } from '../segmentation/segmentation.service';
import { BlockTranslator, TranslationContext } from '../translation/block-translator';
import { SchemaMapperService } from '../schema-mapper/schema-mapper.service';
import { ConfidenceCalculator } from '../validation/confidence-calculator';
import { PurchaseValidator } from '../validation/validators/purchase.validator';
import { BillingValidator } from '../validation/validators/billing.validator';
import { ValidationService } from '../validation/validation.service';
import { QualityGateService } from '../validation/quality-gate.service';
import { AuctionSheetProcessor } from '../auction/auction-sheet.processor';

const prisma = new PrismaClient();

/**
 * OrchestratorService v2 — drives a document through the corrected pipeline:
 *
 *   INGEST → CLASSIFY → EXTRACT → UNDERSTAND → SEGMENT
 *          → TRANSLATE → NORMALIZE → VALIDATE → EXPORT
 *
 * Strategy Pattern:
 * - AUCTION_SHEET: fast-path to AuctionSheetProcessor (preserves existing logic)
 * - PURCHASE / BILLING / INVOICE: full pipeline with Understanding Layer
 *
 * Resilience:
 * - Idempotent state machine (picks up from current stage)
 * - Block-level failure isolation
 * - Group-level isolation for multi-document PDFs
 * - Retry from any stage
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  /** Pipeline version for idempotency and tracing */
  private readonly PIPELINE_VERSION = '2.0.0';

  constructor(
    private classifier: ClassifierService,
    private extraction: ExtractionService,
    private understanding: UnderstandingService,
    private segmentation: SegmentationService,
    private blockTranslator: BlockTranslator,
    private schemaMapper: SchemaMapperService,
    private confidenceCalc: ConfidenceCalculator,
    private purchaseValidator: PurchaseValidator,
    private billingValidator: BillingValidator,
    private validator: ValidationService,
    private qualityGate: QualityGateService,
    private auctionProcessor: AuctionSheetProcessor,
  ) {}

  /**
   * Run the full pipeline for one document. Idempotent — picks up from
   * wherever the document currently sits in the stage sequence.
   */
  async runPipeline(documentId: string): Promise<void> {
    this.logger.log(`▶ Pipeline v${this.PIPELINE_VERSION} started for ${documentId}`);

    const doc = await prisma.document.findUnique({ where: { id: documentId } });
    if (!doc) throw new Error(`Document ${documentId} not found`);

    // Mark processing + pipeline version
    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: 'PROCESSING',
        processingStarted: new Date(),
        pipelineVersion: this.PIPELINE_VERSION,
      },
    });

    const timing: Record<string, number> = {};

    try {
      const stage = doc.stage;

      // ── STEP 1: Classification ─────────────────────────
      if (this.shouldRun(stage, 'CLASSIFIED')) {
        const t = Date.now();
        this.logger.debug(`[${documentId}] → CLASSIFY`);
        await this.classifier.classifyDocument(documentId);
        timing.classify_ms = Date.now() - t;
        await this.audit(documentId, 'classified', 'CLASSIFIED', { timing: timing.classify_ms });
      }

      // ── STEP 2: Route by document type (Strategy Pattern) ──
      const freshDoc = await prisma.document.findUnique({ where: { id: documentId } });
      const docType = freshDoc?.documentType;

      if (docType === 'AUCTION_SHEET') {
        // ── AUCTION_SHEET fast-path ──────────────────────────
        this.logger.log(`[${documentId}] Routing to AuctionSheetProcessor`);
        const t = Date.now();
        const result = await this.auctionProcessor.process(documentId);
        timing.auction_ms = Date.now() - t;
        await this.audit(documentId, 'auction_processed', 'EXPOSED', {
          type: result.type,
          confidence: result.confidence,
          flags: result.flags,
          timing,
        });
        this.logger.log(`✔ Auction pipeline finished for ${documentId} (confidence: ${result.confidence})`);
        return;
      }

      // ── FULL PIPELINE (PURCHASE, BILLING, INVOICE, etc.) ──
      this.logger.log(`[${documentId}] Routing to full pipeline (type: ${docType})`);

      // ── STEP 3: Extraction ─────────────────────────────
      let extractionResult: any = null;
      if (this.shouldRun(stage, 'EXTRACTED')) {
        const t = Date.now();
        this.logger.debug(`[${documentId}] → EXTRACT`);
        extractionResult = await this.extraction.extractStructuredData(documentId);
        timing.extract_ms = Date.now() - t;
        await this.audit(documentId, 'extracted', 'EXTRACTED', {
          engine: extractionResult?.engine,
          blockCount: extractionResult?.blocks?.length,
          timing: timing.extract_ms,
        });
      }

      // ── STEP 4: Understanding ──────────────────────────
      if (this.shouldRun(stage, 'UNDERSTOOD')) {
        const t = Date.now();
        this.logger.debug(`[${documentId}] → UNDERSTAND`);

        // Get extraction blocks
        const docData = await prisma.document.findUnique({ where: { id: documentId } });
        const rawExtraction = docData?.rawExtraction as any;
        const blocks = rawExtraction?.blocks || [];

        const understandingResult = await this.understanding.understand(blocks);

        // Persist understanding results
        await prisma.document.update({
          where: { id: documentId },
          data: {
            normalizedData: {
              blocks: understandingResult.blocks,
              tables: understandingResult.tables,
              keyValuePairs: understandingResult.keyValuePairs,
              fieldCandidates: understandingResult.fieldCandidates,
            } as any,
            stage: 'UNDERSTOOD',
          },
        });

        timing.understand_ms = Date.now() - t;
        await this.audit(documentId, 'understood', 'UNDERSTOOD', {
          blockCount: understandingResult.blocks.length,
          tableCount: understandingResult.tables.length,
          kvPairs: understandingResult.keyValuePairs.length,
          fieldCandidates: understandingResult.fieldCandidates.length,
          timing: timing.understand_ms,
        });
      }

      // ── STEP 5: Segmentation ───────────────────────────
      if (this.shouldRun(stage, 'SEGMENTED')) {
        const t = Date.now();
        this.logger.debug(`[${documentId}] → SEGMENT`);

        const docData = await prisma.document.findUnique({ where: { id: documentId } });
        const normalized = docData?.normalizedData as any;
        const blocks = normalized?.blocks || [];
        const candidates = normalized?.fieldCandidates || [];
        const pageCount = docData?.pageCount || 1;

        const segmentationResult = this.segmentation.segment(blocks, candidates, pageCount);

        // Persist document groups
        for (const group of segmentationResult.groups) {
          await prisma.documentGroup.create({
            data: {
              documentId,
              groupIndex: group.groupIndex,
              groupType: group.groupType,
              pageStart: group.pageRange.start,
              pageEnd: group.pageRange.end,
              identifiers: group.identifiers as any,
              confidence: group.confidence,
              signals: group.signals as any,
            },
          });
        }

        await prisma.document.update({
          where: { id: documentId },
          data: { stage: 'SEGMENTED' },
        });

        timing.segment_ms = Date.now() - t;
        await this.audit(documentId, 'segmented', 'SEGMENTED', {
          groupCount: segmentationResult.groups.length,
          timing: timing.segment_ms,
        });
      }

      // ── STEP 6: Translation ────────────────────────────
      if (this.shouldRun(stage, 'TRANSLATED')) {
        const t = Date.now();
        this.logger.debug(`[${documentId}] → TRANSLATE`);

        const docData = await prisma.document.findUnique({ where: { id: documentId } });
        const normalized = docData?.normalizedData as any;
        const blocks = normalized?.blocks || [];

        const context: TranslationContext = {
          documentType: docType || 'UNKNOWN',
          section: 'general',
          previousBlocks: [],
          glossaryHints: [],
          tenantId: docData?.tenantId,
        };

        const translatedBlocks = await this.blockTranslator.translateBatch(
          blocks,
          context,
          documentId,
        );

        await prisma.document.update({
          where: { id: documentId },
          data: {
            translatedData: { blocks: translatedBlocks } as any,
            stage: 'TRANSLATED',
          },
        });

        timing.translate_ms = Date.now() - t;
        await this.audit(documentId, 'translated', 'TRANSLATED', {
          blockCount: translatedBlocks.length,
          timing: timing.translate_ms,
        });
      }

      // ── STEP 7: Schema Mapping (replaces old NORMALIZED) ──
      if (this.shouldRun(stage, 'NORMALIZED')) {
        const t = Date.now();
        this.logger.debug(`[${documentId}] → MAP + NORMALIZE`);

        const docData = await prisma.document.findUnique({ where: { id: documentId } });
        const normalized = docData?.normalizedData as any;
        const translated = docData?.translatedData as any;
        const candidates = normalized?.fieldCandidates || [];
        const translatedBlocks = translated?.blocks || [];

        const mappingResult = this.schemaMapper.map(
          docType || 'UNKNOWN',
          candidates,
          translatedBlocks,
          documentId,
        );

        await prisma.document.update({
          where: { id: documentId },
          data: {
            canonicalJson: mappingResult.canonicalOutput as any,
            stage: 'NORMALIZED',
          },
        });

        timing.map_ms = Date.now() - t;
        await this.audit(documentId, 'mapped', 'NORMALIZED', {
          mappedFields: mappingResult.mappingTrace.fieldMappings.length,
          warnings: mappingResult.mappingTrace.warnings,
          timing: timing.map_ms,
        });
      }

      // ── STEP 8: Validation ─────────────────────────────
      if (this.shouldRun(stage, 'VALIDATED')) {
        const t = Date.now();
        this.logger.debug(`[${documentId}] → VALIDATE`);

        const docData = await prisma.document.findUnique({ where: { id: documentId } });
        const canonical = docData?.canonicalJson as any;

        // Type-dispatched validation
        let validationErrors: any[] = [];
        if (docType === 'PURCHASE' || docType === 'PURCHASE_ORDER') {
          validationErrors = this.purchaseValidator.validate(canonical);
        } else if (docType === 'BILLING' || docType === 'INVOICE') {
          validationErrors = this.billingValidator.validate(canonical);
        }

        // Also run the existing validation service for schema check
        await this.validator.validateAndMap(documentId, canonical);

        await prisma.document.update({
          where: { id: documentId },
          data: {
            validationErrors: validationErrors as any,
            stage: 'VALIDATED',
          },
        });

        timing.validate_ms = Date.now() - t;
        await this.audit(documentId, 'validated', 'VALIDATED', {
          errorCount: validationErrors.length,
          errors: validationErrors.filter((e: any) => e.severity === 'error').length,
          warnings: validationErrors.filter((e: any) => e.severity === 'warning').length,
          timing: timing.validate_ms,
        });
      }

      // ── STEP 9: Quality Gate ───────────────────────────
      if (this.shouldRun(stage, 'QUALITY_CHECKED')) {
        const t = Date.now();
        this.logger.debug(`[${documentId}] → QUALITY GATE`);

        const finalStatus = await this.qualityGate.evaluate(documentId);
        timing.quality_ms = Date.now() - t;

        await this.audit(documentId, 'quality_checked', 'QUALITY_CHECKED', {
          status: finalStatus,
          timing: timing.quality_ms,
        });
        this.logger.log(`[${documentId}] Quality gate → ${finalStatus}`);
      }

      // Mark finished
      await prisma.document.update({
        where: { id: documentId },
        data: {
          stage: 'EXPOSED',
          processingEnded: new Date(),
        },
      });

      this.logger.log(
        `✔ Pipeline v${this.PIPELINE_VERSION} finished for ${documentId}. Timing: ${JSON.stringify(timing)}`,
      );
    } catch (err: any) {
      this.logger.error(`✘ Pipeline failed for ${documentId}: ${err.message}`, err.stack);

      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: 'FAILED',
          processingEnded: new Date(),
        },
      });

      await this.audit(documentId, 'failed', doc.stage, {
        error: err.message,
        timing,
      });
      throw err; // BullMQ will retry based on job config
    }
  }

  /**
   * Retry pipeline from a specific stage.
   */
  async retryFromStage(documentId: string, fromStage: string): Promise<void> {
    this.logger.log(`Retrying ${documentId} from stage ${fromStage}`);

    // Reset stage to trigger re-run
    await prisma.document.update({
      where: { id: documentId },
      data: {
        stage: fromStage as any,
        status: 'QUEUED',
      },
    });

    await this.audit(documentId, 'retry', fromStage, { fromStage });
    await this.runPipeline(documentId);
  }

  // ─── Stage ordering helper ─────────────────────────────
  private readonly STAGE_ORDER = [
    'INGESTED',
    'CLASSIFIED',
    'EXTRACTED',
    'UNDERSTOOD',
    'SEGMENTED',
    'TRANSLATED',
    'NORMALIZED',
    'VALIDATED',
    'QUALITY_CHECKED',
    'STORED',
    'EXPOSED',
  ];

  /** Return true if current stage has NOT yet reached `target`. */
  private shouldRun(currentStage: string, target: string): boolean {
    const currentIdx = this.STAGE_ORDER.indexOf(currentStage);
    const targetIdx = this.STAGE_ORDER.indexOf(target);
    return currentIdx < targetIdx;
  }

  // ─── Audit helper ─────────────────────────────────────
  private async audit(documentId: string, action: string, stage: string, details?: any) {
    await prisma.auditLog.create({
      data: { documentId, action, stage, actor: 'system', details },
    });
  }
}
