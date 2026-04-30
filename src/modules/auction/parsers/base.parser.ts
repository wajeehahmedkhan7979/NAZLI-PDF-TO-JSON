import { Logger } from '@nestjs/common';
import { PurchaseRecord } from '../../../common/schemas/purchase.schema';

/**
 * Internal parsing result before final schema mapping.
 */
export interface RawParsedRow {
  chassis: string | null;
  bid: number | null;
  total: number | null;
  date: string | null;
  auction: string | null;
  area: string | null;
  lotNumber: number | null;
  recycle: number | null;
  jidosha: number | null;
  auctionFee: number | null;
  confidence: number;
  flags: string[];
}

/**
 * Abstract BaseParser — Defines the contract and common utilities for template parsers.
 */
export abstract class BaseParser {
  protected readonly logger = new Logger(this.constructor.name);

  protected readonly CHASSIS_REGEX = /([A-Z0-9]+-\d+)/;
  protected readonly DATE_REGEX = /(\d{1,2}\/\d{1,2})/;
  protected readonly NUMERIC_REGEX = /\d{1,3}(?:,\d{3})*/g;

  /**
   * Main entry point for parsing a vehicle block.
   */
  abstract parse(block: string[], documentYear: number): RawParsedRow;

  /**
   * Anchor a row by its chassis number. 
   * IF NO CHASSIS IS FOUND, THE ROW IS INVALID.
   */
  protected findChassisAnchor(block: string[]): string | null {
    for (const line of block) {
      const match = line.match(this.CHASSIS_REGEX);
      if (match) return match[1];
    }
    return null;
  }

  /**
   * Clean numeric strings and convert to numbers.
   */
  protected parseNumeric(str: string | undefined): number | null {
    if (!str) return null;
    const digits = str.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : null;
  }

  /**
   * Multi-factor confidence scoring.
   */
  protected calculateConfidence(row: RawParsedRow): number {
    let score = 1.0;

    // 1. Completeness (30%)
    const requiredFields = ['chassis', 'bid', 'total'];
    const missingCount = requiredFields.filter(f => !(row as any)[f]).length;
    score -= (missingCount / requiredFields.length) * 0.3;

    // 2. Math Validity (30%)
    if (row.total && row.bid) {
      const calcTotal = (row.bid || 0) + (row.recycle || 0) + (row.jidosha || 0) + (row.auctionFee || 0);
      const diff = Math.abs(row.total - calcTotal);
      
      // Check for tax (10%)
      const tax = Math.floor(row.bid * 0.1);
      const isTaxMatched = Math.abs(diff - tax) < 1000;

      if (diff > 1000 && !isTaxMatched) {
        score -= 0.3;
        row.flags.push('MATH_MISMATCH');
      }
    } else {
      score -= 0.3; // Cannot verify math
    }

    // 3. Pattern Strength (20%)
    if (row.flags.includes('FALLBACK_USED')) score -= 0.1;
    if (row.flags.includes('CHASSIS_NOT_FOUND')) score -= 0.1;

    // 4. Anchor Quality (20%)
    if (!row.chassis) score -= 0.2;

    return Math.max(0, Math.min(1, parseFloat(score.toFixed(3))));
  }

  /**
   * Final validation: Enforce REQUIRED fields.
   */
  protected isValid(row: RawParsedRow): boolean {
    return !!(row.chassis && row.bid && row.total);
  }
}
