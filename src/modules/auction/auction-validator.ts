import { Injectable, Logger } from '@nestjs/common';
import { PurchaseRecord } from '../../common/schemas/purchase.schema';

/**
 * Auction Validator — Per-row validation with cross-field checks + confidence scoring.
 *
 * Rules:
 * - chassis must exist and match regex
 * - total must be a positive number
 * - lotNumber should exist
 * - date must be valid
 * - Cross: total >= bid (if both exist)
 * - Cross: fee < total (if both exist)
 */
@Injectable()
export class AuctionValidator {
  private readonly logger = new Logger(AuctionValidator.name);

  private readonly CHASSIS_REGEX = /^[A-Z0-9]+-\d+$/;

  /**
   * Validate a single purchase record. Mutates confidence and flags in-place.
   * @returns true if row is valid (possibly with warnings), false if INVALID
   */
  validateRow(row: PurchaseRecord): { valid: boolean; flags: string[]; confidence: number } {
    const flags: string[] = [...(row.flags || [])];
    let confidence = 1.0;

    // ─── Verification Rules ───────────────────────────────────
    if (!row.chassis || !this.CHASSIS_REGEX.test(row.chassis)) {
      flags.push('INVALID_CHASSIS');
      confidence -= 0.5;
    }

    if (!row.total || row.total <= 0) {
      if (!flags.includes('MISSING_TOTAL')) {
        flags.push('MISSING_TOTAL');
      }
      confidence -= 0.5;
    }

    if (flags.includes('FALLBACK_USED') || flags.includes('NO_PACKED_LINE')) {
      confidence -= 0.2;
    }

    // Mathematical sanity: total ≈ bid + recycle + jidosha + auctionFee
    if (row.total && row.bid) {
      const bid = row.bid || 0;
      const recycle = row.recycle || 0;
      const jidosha = row.jidosha || 0;
      const fee = row.auctionFee || 0;
      const calcTotal = bid + recycle + jidosha + fee;
      
      const diff = Math.abs(row.total - calcTotal);
      
      // If diff is greater than a few thousand, it's a math mismatch unless tax applies
      const taxAmount = Math.floor(bid * 0.1);
      const isTaxDiff = Math.abs(diff - taxAmount) < 1000;
      
      if (diff > 1000 && !isTaxDiff) {
        flags.push('MATH_MISMATCH');
        confidence -= 0.3;
      }
    }

    if (row.lotNumber === undefined || !row.date) {
      if (!flags.includes('MISSING_OPTIONAL_FIELDS')) {
        flags.push('MISSING_OPTIONAL_FIELDS');
      }
      confidence -= 0.1;
    }

    if (row.auction === 'UNKNOWN' || !row.area) {
      if (!flags.includes('AMBIGUOUS_SOURCE')) {
        flags.push('AMBIGUOUS_SOURCE');
      }
      confidence -= 0.1;
    }

    // Ensure confidence stays smoothly bounded
    confidence = Math.max(0, Math.min(1, parseFloat(confidence.toFixed(3))));

    const hasValidChassis = row.chassis && this.CHASSIS_REGEX.test(row.chassis);
    const hasValidPrice = row.total !== undefined && row.total > 0;
    
    // HARD REJECT RULES
    const valid = confidence >= 0.5 && hasValidChassis && hasValidPrice && !flags.includes('MATH_MISMATCH');

    if (!valid) {
      if (!hasValidChassis) flags.push('HARD_REJECT_NO_CHASSIS');
      if (!hasValidPrice) flags.push('HARD_REJECT_NO_PRICE');
      if (flags.includes('MATH_MISMATCH')) flags.push('NEEDS_REVIEW');
      this.logger.warn(`Row INVALID: chassis=${row.chassis}, flags=${flags.join(',')}`);
    }

    return { valid, flags, confidence };
  }

  /**
   * Validate all rows and return summary statistics.
   */
  validateAll(rows: PurchaseRecord[]): {
    validatedRows: PurchaseRecord[];
    validCount: number;
    invalidCount: number;
    reviewCount: number;
  } {
    let validCount = 0;
    let invalidCount = 0;
    let reviewCount = 0;

    const validatedRows = rows.map(row => {
      const result = this.validateRow(row);
      const updatedRow: PurchaseRecord = {
        ...row,
        confidence: result.confidence,
        flags: result.flags,
      };

      if (!result.valid) {
        invalidCount++;
        if (!updatedRow.flags.includes('NEEDS_REVIEW')) {
          updatedRow.flags.push('NEEDS_REVIEW');
        }
      } else if (result.flags.length > 0 || result.confidence < 0.7) {
        reviewCount++;
      } else {
        validCount++;
      }

      return updatedRow;
    }).filter(row => !row.flags.includes('HARD_REJECT_NO_CHASSIS') && !row.flags.includes('HARD_REJECT_NO_PRICE'));

    this.logger.log(
      `Validation: ${validCount} valid, ${reviewCount} review, ${invalidCount} invalid, ${rows.length - validatedRows.length} hard rejected`,
    );

    return { validatedRows, validCount, invalidCount, reviewCount };
  }
}
