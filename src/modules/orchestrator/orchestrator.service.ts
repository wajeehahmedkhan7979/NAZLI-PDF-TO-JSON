import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ClassifierService } from '../classifier/classifier.service';
import { AuctionSheetProcessor } from '../auction/auction-sheet.processor';

const prisma = new PrismaClient();

/**
 * OrchestratorService v3 — Simplified linear flow for purchase extraction.
 *
 * Pipeline:
 *   INGEST → CLASSIFY → PROCESS (Purchase/Auction) → EXPOSE
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly PIPELINE_VERSION = '3.0.0';

  constructor(
    private classifier: ClassifierService,
    private auctionProcessor: AuctionSheetProcessor,
  ) {}

  /**
   * Run the simplified pipeline for one document.
   */
  async runPipeline(documentId: string): Promise<void> {
    this.logger.log(`▶ Simplified Purchase Pipeline v${this.PIPELINE_VERSION} started for ${documentId}`);

    const doc = await prisma.document.findUnique({ where: { id: documentId } });
    if (!doc) throw new Error(`Document ${documentId} not found`);

    // Mark processing
    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: 'PROCESSING',
        processingStarted: new Date(),
        pipelineVersion: this.PIPELINE_VERSION,
      },
    });

    try {
      // ── STEP 1: Classification ─────────────────────────
      this.logger.debug(`[${documentId}] → CLASSIFY`);
      await this.classifier.classifyDocument(documentId);

      const freshDoc = await prisma.document.findUnique({ where: { id: documentId } });
      const docType = freshDoc?.documentType;

      if (docType !== 'AUCTION_SHEET' && docType !== 'PURCHASE') {
        this.logger.warn(`[${documentId}] Document type ${docType} is not a supported purchase format. Attempting anyway...`);
      }

      // ── STEP 2: Purchase Extraction (Auction Sheet Processor) ──
      this.logger.debug(`[${documentId}] → PROCESS (Purchase)`);
      const result = await this.auctionProcessor.process(documentId);

      // The auctionProcessor already persists canonicalJson and updates status.
      
      this.logger.log(
        `✔ Simplified pipeline finished for ${documentId}. Rows: ${result.payload.rows.length}, Confidence: ${result.confidence}`,
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

      await prisma.auditLog.create({
        data: {
          documentId,
          action: 'failed',
          stage: 'ERROR',
          actor: 'system',
          details: { error: err.message },
        },
      });
      throw err;
    }
  }
}
