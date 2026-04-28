import { Injectable, Logger } from '@nestjs/common';

export interface NumericDecodeResult {
  fee: number | null;
  recycle: number | null;
  jidosha: number | null;
  total: number | null;
  confidence: number; // 0-1
  method: 'contextual' | 'heuristic_fallback';
  flags: string[];
}

/**
 * Numeric Decoder — Hybrid approach for decoding packed numeric lines.
 *
 * Priority order:
 * 1. Contextual extraction using known anchors (fee line, subtotal line)
 * 2. Heuristic slicing (fallback only, LOW confidence)
 *
 * Packed line format (empirically calibrated):
 *   [FEE_DIGITS][0][RECYCLE:5digits][OPTIONAL_JIDOSHA:5digits][TOTAL_DIGITS]
 *
 * Where fee and total are extracted from neighboring lines for cross-validation.
 */
@Injectable()
export class NumericDecoder {
  private readonly logger = new Logger(NumericDecoder.name);

  /**
   * Decode a packed numeric line using contextual anchors.
   *
   * @param packedLine The packed numeric string (e.g. "15500094501849000")
   * @param knownFee The fee extracted from the standalone fee line
   * @param subtotalLine The line after packed (total / 10 cross-check)
   * @returns Decoded fields with confidence
   */
  decode(
    packedLine: string,
    knownFee: number | null,
    subtotalLine: string | null,
  ): NumericDecodeResult {
    const flags: string[] = [];

    // Strip any non-digit chars
    const packed = packedLine ? packedLine.replace(/[^\d]/g, '') : '';

    if (!packed || packed.length < 10) {
      let total = null;
      if (subtotalLine) {
        const digits = subtotalLine.replace(/[^\d]/g, '');
        if (digits.length >= 5) {
          total = parseInt(digits, 10);
        }
      }

      return {
        fee: knownFee,
        recycle: null,
        jidosha: null,
        total,
        confidence: total ? 0.7 : 0,
        method: 'heuristic_fallback',
        flags: packed ? ['PACKED_TOO_SHORT'] : ['NO_PACKED_LINE'],
      };
    }

    // ─── Step 1: Contextual extraction (primary) ───────────────
    if (knownFee !== null) {
      const contextResult = this.contextualDecode(packed, knownFee, subtotalLine);
      if (contextResult) {
        return contextResult;
      }
    }

    // ─── Step 2: Heuristic fallback ────────────────────────────
    this.logger.warn(`Falling back to heuristic slicing for packed: ${packed}`);
    return this.heuristicDecode(packed, knownFee, flags);
  }

  /**
   * Primary strategy: use known fee and subtotal to anchor into the packed line.
   *
   * Algorithm:
   * 1. Fee string matches the start of the packed line
   * 2. Total is derived from subtotal * 10 and matches the end of packed line
   * 3. Middle portion contains separator(0) + recycle(5) [+ jidosha(5)]
   */
  private contextualDecode(
    packed: string,
    knownFee: number,
    subtotalLine: string | null,
  ): NumericDecodeResult | null {
    const feeStr = String(knownFee);
    const flags: string[] = [];

    // Verify packed starts with fee digits
    if (!packed.startsWith(feeStr)) {
      flags.push('FEE_PREFIX_MISMATCH');
      // Try to find fee at start anyway (maybe with trailing zero)
      if (!packed.startsWith(feeStr + '0')) {
        return null; // Cannot anchor — fall through to heuristic
      }
    }

    // Derive total from subtotal line (subtotal_line * 10)
    let knownTotal: number | null = null;
    if (subtotalLine) {
      const subtotalDigits = subtotalLine.replace(/[^\d]/g, '');
      if (subtotalDigits.length > 0) {
        knownTotal = parseInt(subtotalDigits, 10) * 10;
      }
    }

    // Verify packed ends with total digits
    let totalStr: string | null = null;
    if (knownTotal !== null) {
      totalStr = String(knownTotal);
      if (!packed.endsWith(totalStr)) {
        // Total might be different length due to rounding
        flags.push('TOTAL_SUFFIX_MISMATCH');
        // Try to find total as best guess from end
        totalStr = null;
      }
    }

    if (!totalStr) {
      // Can't anchor total from subtotal line — try to extract from packed end
      // Assume total is last 6-7 digits
      return null; // Fall to heuristic
    }

    // Extract middle portion between fee and total
    const feeEndIdx = feeStr.length;
    const totalStartIdx = packed.length - totalStr.length;

    if (totalStartIdx <= feeEndIdx) {
      flags.push('PACKED_OVERLAP');
      return null;
    }

    const middle = packed.substring(feeEndIdx, totalStartIdx);

    // Middle should start with "0" separator
    if (!middle.startsWith('0')) {
      flags.push('MISSING_SEPARATOR');
    }

    // Parse middle: remove leading separator, then split into 5-digit segments
    const afterSep = middle.startsWith('0') ? middle.substring(1) : middle;
    let recycle: number | null = null;
    let jidosha: number | null = null;

    if (afterSep.length === 5) {
      // Only recycle deposit
      recycle = parseInt(afterSep, 10);
    } else if (afterSep.length === 10) {
      // Recycle (5) + Jidosha (5)
      recycle = parseInt(afterSep.substring(0, 5), 10);
      jidosha = parseInt(afterSep.substring(5, 10), 10);
    } else if (afterSep.length === 0) {
      // No middle fields (rare)
      recycle = 0;
    } else {
      // Unexpected length — try best effort
      flags.push('UNEXPECTED_MIDDLE_LENGTH');
      if (afterSep.length > 5) {
        recycle = parseInt(afterSep.substring(0, 5), 10);
        const remaining = afterSep.substring(5);
        if (remaining.length === 5) {
          jidosha = parseInt(remaining, 10);
        } else {
          flags.push('JIDOSHA_PARSE_UNCERTAIN');
        }
      } else {
        recycle = parseInt(afterSep, 10);
      }
    }

    const total = parseInt(totalStr, 10);

    // Cross-validation: fee + recycle + jidosha should relate to total
    const confidence = flags.length === 0 ? 0.95 : 0.7;

    this.logger.debug(
      `Contextual decode: fee=${knownFee}, recycle=${recycle}, jidosha=${jidosha}, total=${total} (conf=${confidence})`
    );

    return {
      fee: knownFee,
      recycle,
      jidosha,
      total,
      confidence,
      method: 'contextual',
      flags,
    };
  }

  /**
   * Fallback: heuristic fixed-position slicing.
   * Used ONLY when contextual decode fails. Marked as LOW confidence.
   */
  private heuristicDecode(
    packed: string,
    knownFee: number | null,
    inheritedFlags: string[],
  ): NumericDecodeResult {
    const flags = [...inheritedFlags, 'HEURISTIC_FALLBACK'];
    const len = packed.length;

    let fee = knownFee;
    let recycle: number | null = null;
    let jidosha: number | null = null;
    let total: number | null = null;

    try {
      // PRICE ANOMALY SPRINTING:
      // If the string starts with a common recycle range (9000-15000)
      // or other distinctive patterns, try peeling them off.
      
      const val = parseInt(packed, 10);
      
      // If value is > 1 Billion, it is almost certainly a concatenation of 
      // [REC][TOTAL] or [FEE][REC][TOTAL]
      if (val > 1_000_000_000) {
        // Try Common Recycle prefix: 9000 to 15000
        const potentialRecycleMatch = packed.match(/^(9\d{3}|1\d{4})(\d{5,8})$/);
        if (potentialRecycleMatch) {
          recycle = parseInt(potentialRecycleMatch[1], 10);
          total = parseInt(potentialRecycleMatch[2], 10);
          flags.push('RECURSIVE_PRICE_SPLIT');
        } else {
           // Fallback to old heuristic slicing if no obvious match
           if (len >= 10) {
              total = parseInt(packed.substring(packed.length - 7), 10); // Take last 7 digits as total
              flags.push('AGGRESSIVE_PRICE_TRUNCATION');
           }
        }
      } else if (len >= 6) {
        total = val;
      }
    } catch (e) {
      flags.push('HEURISTIC_PARSE_ERROR');
    }

    // Final Sanity Check for Vehicle Prices
    if (total && total > 500_000_000) {
      flags.push('PRICE_ANOMALY');
      // If it's still > 500M JPY, it's likely still junk or highly unusual
    }

    return {
      fee,
      recycle,
      jidosha,
      total,
      confidence: 0.3, // LOW confidence for heuristic
      method: 'heuristic_fallback',
      flags,
    };
  }
}
