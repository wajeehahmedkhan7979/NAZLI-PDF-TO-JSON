import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as pdfParse from 'pdf-parse';
import * as fs from 'fs';
import { DocumentProcessor, DocumentProcessorResult } from '../../common/interfaces/document-processor.interface';
import { BlockSegmenter } from './block-segmenter';
import { AuctionParser } from './auction-parser';
import { ColumnMapper } from './column-mapper';
import { AuctionValidator } from './auction-validator';
import { AuctionSheetDocument, AuctionRow } from '../../common/schemas/auction.schema';

const prisma = new PrismaClient();

/**
 * AuctionSheetProcessor — Strategy implementation for AUCTION_SHEET documents.
 *
 * Pipeline:
 *   Raw Text → Line Preprocessing → Block Segmentation
 *   → Row Reconstruction → Column Mapping → Validation → JSON Output
 *
 * This processor DOES NOT use:
 * - LLM for parsing
 * - Key-value semantic extraction
 * - Translation before structuring
 */
@Injectable()
export class AuctionSheetProcessor implements DocumentProcessor {
  private readonly logger = new Logger(AuctionSheetProcessor.name);

  constructor(
    private blockSegmenter: BlockSegmenter,
    private auctionParser: AuctionParser,
    private columnMapper: ColumnMapper,
    private auctionValidator: AuctionValidator,
  ) {}

  /**
   * Process an auction sheet document through the full deterministic pipeline.
   */
  async process(documentId: string): Promise<DocumentProcessorResult> {
    const document = await prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new Error(`Document ${documentId} not found`);

    this.logger.log(`▶ Auction pipeline started for ${documentId}`);

    // ── Step 1: Raw Text Acquisition ──────────────────────────
    const rawText = await this.extractRawText(document.storagePath);

    if (!rawText || rawText.trim().length < 10) {
      this.logger.warn(`Document ${documentId} has no extractable text — may need OCR`);
      return {
        type: 'AUCTION_SHEET',
        payload: this.buildEmptyResult(document),
        confidence: 0,
        flags: ['NO_TEXT_CONTENT', 'NEEDS_OCR'],
      };
    }

    // ── Step 2: Extract document-level metadata ───────────────
    const docMeta = this.extractDocumentMeta(rawText, document.originalName);

    // ── Step 3: Block Segmentation ────────────────────────────
    const blocks = this.blockSegmenter.segment(rawText);
    this.logger.log(`Found ${blocks.length} vehicle blocks`);

    if (blocks.length === 0) {
      return {
        type: 'AUCTION_SHEET',
        payload: this.buildEmptyResult(document),
        confidence: 0,
        flags: ['NO_BLOCKS_FOUND'],
      };
    }

    // ── Step 4: Row Reconstruction + Column Mapping ───────────
    const rows: AuctionRow[] = [];
    for (const block of blocks) {
      const parsed = this.auctionParser.parseBlock(block);
      const mapped = this.columnMapper.mapRow(parsed, docMeta.year);
      rows.push(mapped);
    }

    // ── Step 5: Validation ────────────────────────────────────
    const { validatedRows, validCount, invalidCount, reviewCount } =
      this.auctionValidator.validateAll(rows);

    // ── Step 6: Build output ──────────────────────────────────
    const output: AuctionSheetDocument = {
      type: 'AUCTION_SHEET',
      rows: validatedRows,
      meta: {
        sourceFile: document.originalName,
        parsedAt: new Date().toISOString(),
        totalRows: validatedRows.length,
        validRows: validCount,
        invalidRows: invalidCount,
        documentDate: docMeta.date || undefined,
        issuer: docMeta.issuer || undefined,
        client: docMeta.client || undefined,
      },
    };

    // Compute overall confidence
    const avgConfidence = validatedRows.length > 0
      ? validatedRows.reduce((sum, r) => sum + r.confidence, 0) / validatedRows.length
      : 0;

    // Collect all flags
    const allFlags: string[] = [];
    if (invalidCount > 0) allFlags.push(`${invalidCount}_INVALID_ROWS`);
    if (reviewCount > 0) allFlags.push(`${reviewCount}_REVIEW_ROWS`);

    // ── Step 7: Persist to database ───────────────────────────
    await this.persistResults(documentId, output, avgConfidence, allFlags);

    this.logger.log(
      `✔ Auction pipeline complete for ${documentId}: ${validCount} valid, ${reviewCount} review, ${invalidCount} invalid`,
    );

    return {
      type: 'AUCTION_SHEET',
      payload: output,
      confidence: parseFloat(avgConfidence.toFixed(3)),
      flags: allFlags,
    };
  }

  /**
   * Extract raw text from PDF using pdf-parse.
   */
  private async extractRawText(filePath: string): Promise<string> {
    try {
      const dataBuffer = await fs.promises.readFile(filePath);
      const pdfData = await pdfParse(dataBuffer);
      return pdfData.text || '';
    } catch (err: any) {
      this.logger.error(`Failed to extract text from ${filePath}: ${err.message}`);
      return '';
    }
  }

  /**
   * Extract document-level metadata from text (date, issuer, client).
   */
  private extractDocumentMeta(rawText: string, filename: string): {
    year: number;
    date: string | null;
    issuer: string | null;
    client: string | null;
  } {
    // Extract year from document date pattern: "2026 年 04 月 04 日"
    const dateMatch = rawText.match(/(\d{4})\s*年\s*(\d{2})\s*月\s*(\d{2})\s*日/);
    let year = new Date().getFullYear();
    let date: string | null = null;

    if (dateMatch) {
      year = parseInt(dateMatch[1], 10);
      date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    }

    // Extract issuer
    const issuerMatch = rawText.match(/発行元\s*([\S]+)/);
    const issuer = issuerMatch ? issuerMatch[1] : null;

    // Extract client
    const clientMatch = rawText.match(/([\S]+)\s*御中/);
    const client = clientMatch ? clientMatch[1] : null;

    return { year, date, issuer, client };
  }

  /**
   * Persist auction results to the database.
   */
  private async persistResults(
    documentId: string,
    output: AuctionSheetDocument,
    confidence: number,
    flags: string[],
  ): Promise<void> {
    // Store canonical JSON
    await prisma.document.update({
      where: { id: documentId },
      data: {
        canonicalJson: output as any,
        frontendJson: output as any,
        overallConfidence: confidence,
        qualityFlags: flags,
        stage: 'EXPOSED',
        status: flags.some(f => f.includes('INVALID')) ? 'NEEDS_REVIEW' : 'COMPLETED',
        processingEnded: new Date(),
      },
    });

    // Store individual rows as line items for the review module
    for (let i = 0; i < output.rows.length; i++) {
      const row = output.rows[i];
      await prisma.lineItem.create({
        data: {
          documentId,
          lineNumber: i + 1,
          originalDescription: row.carName || `Vehicle ${i + 1}`,
          englishDescription: row.carName || undefined,
          quantity: 1,
          unitPrice: row.startingPrice || undefined,
          subtotal: row.finalPrice,
          confidence: row.confidence,
          rawText: (row.rawBlock || []).join('\n'),
          extractionMethod: 'auction_layout_parser',
        },
      });
    }

    // Audit log
    await prisma.auditLog.create({
      data: {
        documentId,
        action: 'auction_processed',
        stage: 'EXPOSED',
        actor: 'system',
        details: {
          totalRows: output.meta.totalRows,
          validRows: output.meta.validRows,
          invalidRows: output.meta.invalidRows,
          confidence,
        } as any,
      },
    });
  }

  private buildEmptyResult(document: any): AuctionSheetDocument {
    return {
      type: 'AUCTION_SHEET',
      rows: [],
      meta: {
        sourceFile: document.originalName,
        parsedAt: new Date().toISOString(),
        totalRows: 0,
        validRows: 0,
        invalidRows: 0,
      },
    };
  }
}
