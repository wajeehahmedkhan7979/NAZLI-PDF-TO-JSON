import { Injectable, Logger } from '@nestjs/common';
import * as pdfParse from 'pdf-parse';
import * as fs from 'fs';
import { PrismaClient, DocumentType } from '@prisma/client';

const prisma = new PrismaClient();

@Injectable()
export class ClassifierService {
  private readonly logger = new Logger(ClassifierService.name);

  // Auction sheet trigger keywords
  private readonly AUCTION_KEYWORDS = ['TC-web', 'ANS', 'USS'];
  private readonly AUCTION_SECONDARY = ['オークション計算書', 'ｵｰｸｼｮﾝ計算書', '出品No', '落札', '成約'];
  private readonly CHASSIS_REGEX = /[A-Z][A-Z0-9]*-\d{4,}/g;

  async classifyDocument(documentId: string): Promise<void> {
    const document = await prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new Error(`Document ${documentId} not found`);

    try {
      const dataBuffer = await fs.promises.readFile(document.storagePath);
      const pdfData = await pdfParse(dataBuffer);
      const text = pdfData.text || '';

      // 1. Text Presence: Are we dealing with a scanned PDF?
      const avgCharsPerPage = text.length / (pdfData.numpages || 1);
      const isScanned = avgCharsPerPage < 50;

      // 2. Language Detection
      const sourceLanguage = this.detectLanguage(text);

      // 3. Document Type Classification — AUCTION_SHEET takes priority
      const documentType = this.classifyType(text, document.originalName);

      // 4. Update the document record
      await prisma.document.update({
        where: { id: documentId },
        data: {
          isScanned,
          sourceLanguage,
          documentType,
          pageCount: pdfData.numpages,
          stage: 'CLASSIFIED',
        },
      });

      this.logger.log(
        `Document ${documentId} classified: ${isScanned ? 'SCANNED' : 'DIGITAL'} ${documentType}`,
      );
    } catch (error: any) {
      this.logger.error(`Classification failed for ${documentId}: ${error.message}`);
      throw error;
    }
  }

  private detectLanguage(text: string): string {
    const japaneseRegex =
      /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf]/;
    return japaneseRegex.test(text) ? 'ja' : 'en';
  }

  private classifyType(text: string, filename: string): DocumentType {
    const combined = text + ' ' + filename;

    // ─── AUCTION_SHEET detection (highest priority) ───────────
    if (this.isAuctionSheet(combined)) {
      return DocumentType.AUCTION_SHEET;
    }

    // ─── Document type classification ────────────────────────

    // Purchase: vehicle sales, buyer/seller with chassis numbers
    if (this.isPurchaseDocument(combined)) {
      return DocumentType.PURCHASE;
    }

    // Billing/Invoice: 請求書 or INVOICE
    if (combined.includes('請求書') || combined.toUpperCase().includes('INVOICE')) {
      return DocumentType.BILLING;
    }

    // Purchase Order
    if (combined.includes('注文書') || combined.toUpperCase().includes('PURCHASE ORDER')) {
      return DocumentType.PURCHASE_ORDER;
    }

    // Receipt
    if (combined.includes('領収書') || combined.toUpperCase().includes('RECEIPT')) {
      return DocumentType.RECEIPT;
    }

    // Packing List
    if (combined.includes('納品書') || combined.toUpperCase().includes('PACKING LIST')) {
      return DocumentType.PACKING_LIST;
    }

    return DocumentType.UNKNOWN;
  }

  /**
   * Detect if a document is a vehicle purchase document.
   * Signals: chassis number + purchase/sale keywords, no auction keywords.
   */
  private isPurchaseDocument(text: string): boolean {
    const chassisMatches = text.match(this.CHASSIS_REGEX);
    if (!chassisMatches || chassisMatches.length === 0) return false;

    const purchaseKeywords = ['売買', '買主', '売主', '購入', '販売', '車両', '自動車'];
    let score = 0;
    for (const kw of purchaseKeywords) {
      if (text.includes(kw)) score++;
    }
    // Single chassis + purchase keywords = purchase doc
    return chassisMatches.length <= 2 && score >= 1;
  }

  /**
   * Detect if a document is an Auction Sheet.
   */
  private isAuctionSheet(text: string): boolean {
    let score = 0;

    for (const kw of this.AUCTION_KEYWORDS) {
      if (text.includes(kw)) score += 3;
    }

    for (const kw of this.AUCTION_SECONDARY) {
      if (text.includes(kw)) score += 1;
    }

    const chassisMatches = text.match(this.CHASSIS_REGEX);
    if (chassisMatches && chassisMatches.length >= 3) {
      score += 4;
    } else if (chassisMatches && chassisMatches.length >= 1) {
      score += 2;
    }

    const dateNumMatches = text.match(/\d{2}\/\d{2}\d{5,}/g);
    if (dateNumMatches && dateNumMatches.length >= 3) {
      score += 3;
    }

    const isAuction = score >= 5;
    if (isAuction) {
      this.logger.log(`Auction sheet detected (score=${score})`);
    }

    return isAuction;
  }
}
