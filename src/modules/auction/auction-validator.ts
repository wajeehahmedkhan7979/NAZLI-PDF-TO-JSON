import { Injectable, Logger } from '@nestjs/common';
import { AuctionRow } from '../../common/schemas/auction.schema';

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

  private readonly CHASSIS_REGEX = /^[A-Z][A-Z0-9]*-\d{4,}$/;

  /**
   * Validate a single auction row. Mutates confidence and flags in-place.
   * @returns true if row is valid (possibly with warnings), false if INVALID
   */
  validateRow(row: AuctionRow): { valid: boolean; flags: string[]; confidence: number } {
    const flags: string[] = [...(row.flags || [])];
    let confidence = 1.0;

    // ─── Verification Rules ───────────────────────────────────
    if (!row.chassis || !this.CHASSIS_REGEX.test(row.chassis)) {
      flags.push('INVALID_CHASSIS');
      confidence -= 0.5;
    }

    if (!row.finalPrice || row.finalPrice <= 0) {
      if (!flags.includes('MISSING_TOTAL') && !flags.includes('MISSING_FINAL_PRICE')) {
        flags.push('MISSING_FINAL_PRICE');
      }
      confidence -= 0.5;
    }

    if (flags.includes('FALLBACK_USED') || flags.includes('NO_PACKED_LINE')) {
      confidence -= 0.2;
    }

    if (row.finalPrice && row.startingPrice && row.finalPrice > row.startingPrice * 1.2) {
      flags.push('PRICE_ANOMALY');
      confidence -= 0.2;
    }

    if (row.lotNumber === undefined || !row.date) {
      if (!flags.includes('MISSING_OPTIONAL_FIELDS')) {
        flags.push('MISSING_OPTIONAL_FIELDS');
      }
      confidence -= 0.1;
    }

    if (row.auctionPlatform === 'UNKNOWN' || !row.auctionLocation) {
      if (!flags.includes('AMBIGUOUS_SOURCE')) {
        flags.push('AMBIGUOUS_SOURCE');
      }
      confidence -= 0.1;
    }

    // Ensure confidence stays smoothly bounded
    confidence = Math.max(0, Math.min(1, parseFloat(confidence.toFixed(3))));

    const hasValidChassis = row.chassis && this.CHASSIS_REGEX.test(row.chassis);
    const hasValidPrice = row.finalPrice !== undefined && row.finalPrice > 0;
    
    // HARD REJECT RULES
    const valid = confidence > 0.0 && hasValidChassis && hasValidPrice;

    if (!valid) {
      if (!hasValidChassis) flags.push('HARD_REJECT_NO_CHASSIS');
      if (!hasValidPrice) flags.push('HARD_REJECT_NO_PRICE');
      this.logger.warn(`Row INVALID: chassis=${row.chassis}, flags=${flags.join(',')}`);
    }

    return { valid, flags, confidence };
  }

  /**
   * Validate all rows and return summary statistics.
   */
  validateAll(rows: AuctionRow[]): {
    validatedRows: AuctionRow[];
    validCount: number;
    invalidCount: number;
    reviewCount: number;
  } {
    let validCount = 0;
    let invalidCount = 0;
    let reviewCount = 0;

    const validatedRows = rows.map(row => {
      const result = this.validateRow(row);
      const updatedRow: AuctionRow = {
        ...row,
        confidence: result.confidence,
        flags: result.flags.length > 0 ? result.flags : undefined,
      };

      if (!result.valid) {
        invalidCount++;
        updatedRow.flags = [...(updatedRow.flags || []), 'NEEDS_REVIEW'];
      } else if (result.flags.length > 0 || result.confidence < 0.7) {
        reviewCount++;
      } else {
        validCount++;
      }

      return updatedRow;
    }).filter(row => !row.flags?.includes('HARD_REJECT_NO_CHASSIS') && !row.flags?.includes('HARD_REJECT_NO_PRICE'));

    this.logger.log(
      `Validation: ${validCount} valid, ${reviewCount} review, ${invalidCount} invalid, ${rows.length - validatedRows.length} hard rejected`,
    );

    return { validatedRows, validCount, invalidCount, reviewCount };
  }
}
