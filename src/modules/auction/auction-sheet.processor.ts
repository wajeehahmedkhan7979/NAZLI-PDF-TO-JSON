import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as pdfParse from 'pdf-parse';
import * as fs from 'fs';
import { DocumentProcessor, DocumentProcessorResult } from '../../common/interfaces/document-processor.interface';
import { BlockSegmenter } from './block-segmenter';
import { AuctionParser } from './auction-parser';
import { ColumnMapper } from './column-mapper';
import { AuctionValidator } from './auction-validator';
import { PurchaseExtractionResult, PurchaseRecord } from '../../common/schemas/purchase.schema';
import { AuctionOcr } from './auction-ocr';

const prisma = new PrismaClient();

/**
 * AuctionSheetProcessor — Strategy implementation for purchase document extraction.
 */
@Injectable()
export class AuctionSheetProcessor implements DocumentProcessor {
  private readonly logger = new Logger(AuctionSheetProcessor.name);

  constructor(
    private blockSegmenter: BlockSegmenter,
    private auctionParser: AuctionParser,
    private columnMapper: ColumnMapper,
    private auctionValidator: AuctionValidator,
    private auctionOcr: AuctionOcr,
  ) {}

  /**
   * Process an auction sheet document through the full deterministic pipeline.
   */
  async process(documentId: string): Promise<DocumentProcessorResult> {
    const document = await prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new Error(`Document ${documentId} not found`);

    this.logger.log(`▶ Purchase pipeline started for ${documentId}`);

    // ── Step 1: Raw Text Acquisition ──────────────────────────
    let rawText = await this.extractRawText(document.storagePath);

    if (!rawText || rawText.trim().length < 10) {
      this.logger.warn(`Document ${documentId} has no extractable text — falling back to OCR`);
      rawText = await this.auctionOcr.extractText(document.storagePath);
    }

    if (!rawText || rawText.trim().length < 10) {
      const payload = this.buildEmptyResult();
      await this.persistResults(documentId, payload, 0, ['NO_TEXT_CONTENT']);
      return { type: 'AUCTION_SHEET', payload, confidence: 0, flags: ['NO_TEXT_CONTENT'] };
    }

    // ── Step 2: Extract document-level metadata ───────────────
    const docMeta = this.extractDocumentMeta(rawText);

    // ── Step 3: Select Template Parser ────────────────────────
    this.auctionParser.selectParser(rawText);

    // ── Step 4: Block Segmentation ────────────────────────────
    const blocks = this.blockSegmenter.segment(rawText);
    this.logger.log(`Found ${blocks.length} vehicle blocks`);

    if (blocks.length === 0) {
      const payload = this.buildEmptyResult();
      await this.persistResults(documentId, payload, 0, ['NO_BLOCKS_FOUND']);
      return { type: 'AUCTION_SHEET', payload, confidence: 0, flags: ['NO_BLOCKS_FOUND'] };
    }

    // ── Step 5: Row Reconstruction + Column Mapping ───────────
    const rawRows: PurchaseRecord[] = [];
    const errors: string[] = [];

    for (const block of blocks) {
      const parsed = this.auctionParser.parseBlock(block, docMeta.year);
      if (parsed) {
        const mapped = this.columnMapper.mapRow(parsed, docMeta.year);
        rawRows.push(mapped);
      } else {
        errors.push('INVALID_ROW_SKIPPED');
      }
    }

    if (rawRows.length === 0) {
      const payload = this.buildEmptyResult();
      payload.errors.push(...errors);
      await this.persistResults(documentId, payload, 0, ['ALL_ROWS_REJECTED']);
      return { type: 'AUCTION_SHEET', payload, confidence: 0, flags: ['ALL_ROWS_REJECTED'] };
    }

    // ── Step 6: Validation ────────────────────────────────────
    const { validatedRows, validCount, invalidCount, reviewCount } =
      this.auctionValidator.validateAll(rawRows);

    // Compute overall confidence
    const avgConfidence = validatedRows.length > 0
      ? validatedRows.reduce((sum, r) => sum + r.confidence, 0) / validatedRows.length
      : 0;

    // ── Step 7: Build output ──────────────────────────────────
    const output: PurchaseExtractionResult = {
      status: invalidCount === 0 ? 'SUCCESS' : (validCount > 0 ? 'PARTIAL' : 'FAILED'),
      records: validatedRows,
      confidence: parseFloat(avgConfidence.toFixed(3)),
      errors: [...errors],
    };

    if (invalidCount > 0) output.errors.push(`${invalidCount} rows failed validation`);

    // Collect all flags
    const allFlags: string[] = [];
    if (invalidCount > 0) allFlags.push(`${invalidCount}_INVALID_ROWS`);
    if (reviewCount > 0) allFlags.push(`${reviewCount}_REVIEW_ROWS`);
    if (errors.length > 0) allFlags.push('HAS_SKIPPED_ROWS');

    // ── Step 8: Persist to database ───────────────────────────
    await this.persistResults(documentId, output, avgConfidence, allFlags);

    return {
      type: 'AUCTION_SHEET',
      payload: output,
      confidence: output.confidence,
      flags: allFlags,
    };
  }

  private async extractRawText(filePath: string): Promise<string> {
    try {
      const dataBuffer = await fs.promises.readFile(filePath);
      const pdfData = await pdfParse(dataBuffer);
      return pdfData.text || '';
    } catch (err: any) {
      this.logger.error(`Failed to extract text: ${err.message}`);
      return '';
    }
  }

  private extractDocumentMeta(rawText: string): { year: number } {
    const dateMatch = rawText.match(/(\d{4})\s*年/);
    let year = new Date().getFullYear();
    if (dateMatch) year = parseInt(dateMatch[1], 10);
    return { year };
  }

  private async persistResults(
    documentId: string,
    output: PurchaseExtractionResult,
    confidence: number,
    flags: string[],
  ): Promise<void> {
    let status = 'COMPLETED';
    if (output.records.length === 0) {
      status = 'FAILED';
    } else if (flags.some(f => f.includes('INVALID') || f.includes('REVIEW'))) {
      status = 'NEEDS_REVIEW';
    }

    await prisma.document.update({
      where: { id: documentId },
      data: {
        canonicalJson: output as any,
        overallConfidence: confidence,
        qualityFlags: flags,
        stage: 'EXPOSED',
        status: status as any,
        processingEnded: new Date(),
      },
    });

    for (let i = 0; i < output.records.length; i++) {
      const row = output.records[i];
      await prisma.lineItem.create({
        data: {
          documentId,
          lineNumber: i + 1,
          originalDescription: row.chassis,
          quantity: 1,
          unitPrice: row.bid,
          subtotal: row.total,
          confidence: row.confidence,
          extractionMethod: 'deterministic_parser',
        },
      });
    }

    await prisma.auditLog.create({
      data: {
        documentId,
        action: 'processed',
        stage: 'EXPOSED',
        actor: 'system',
        details: { rowCount: output.records.length, confidence },
      },
    });
  }

  private buildEmptyResult(): PurchaseExtractionResult {
    return {
      status: 'FAILED',
      records: [],
      confidence: 0,
      errors: ['No extraction results produced'],
    };
  }
}
