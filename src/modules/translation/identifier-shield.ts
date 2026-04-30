import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';

/**
 * IdentifierShield — protects identifiers from being mangled by translation.
 *
 * Before translation: replaces identifiers with sentinel tokens (__VIN_0__, __DATE_0__, etc.)
 * After translation: restores original values.
 *
 * Registry-driven: patterns are defined in a central registry, not hardcoded
 * in individual translation calls.
 */

export interface IdentifierPattern {
  name: string;
  pattern: RegExp;
  /** Priority: higher = checked first (prevents greedy shorter patterns matching first) */
  priority: number;
}

export interface ShieldedText {
  /** Text with identifiers replaced by sentinel tokens */
  shieldedText: string;
  /** Map of sentinel → original value */
  tokens: Map<string, string>;
  /** List of identified items for audit */
  identifiedItems: Array<{
    type: string;
    original: string;
    sentinel: string;
    position: number;
  }>;
}

@Injectable()
export class IdentifierShield {
  private readonly logger = new Logger(IdentifierShield.name);

  /**
   * Pattern registry — ordered by priority (highest first).
   * Higher priority patterns are matched first to prevent partial matches.
   */
  private readonly PATTERNS: IdentifierPattern[] = [
    // VIN: exactly 17 alphanumeric chars (no I, O, Q)
    { name: 'VIN', pattern: /\b[A-HJ-NPR-Z0-9]{17}\b/g, priority: 100 },

    // Japanese chassis: ABC123-4567890
    { name: 'CHASSIS', pattern: /\b[A-Z][A-Z0-9]{2,}-\d{4,}\b/g, priority: 95 },

    // Auction codes: TC-web, ANS, USS followed by optional alphanumerics
    { name: 'AUCTION_CODE', pattern: /\b(TC-web|ANS|USS)[A-Z0-9\-]*/g, priority: 90 },

    // Japanese era dates: 令和5年12月25日
    { name: 'DATE_ERA', pattern: /(令和|平成|昭和|大正)\d{1,2}年\d{1,2}月\d{1,2}日/g, priority: 85 },

    // ISO dates: 2024-12-25 or 2024/12/25
    { name: 'DATE_ISO', pattern: /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, priority: 80 },

    // Japanese dates: 2024年12月25日
    { name: 'DATE_JP', pattern: /\d{4}年\d{1,2}月\d{1,2}日/g, priority: 80 },

    // Short dates: 04/04 (auction sheets)
    { name: 'DATE_SHORT', pattern: /\b\d{2}\/\d{2}\b/g, priority: 50 },

    // Currency values with symbol: ¥1,234,567 or ￥1,234,567 or 1,234,567円
    { name: 'CURRENCY', pattern: /(?:[¥￥]\s?[\d,]+|[\d,]+円)/g, priority: 75 },

    // Postal codes: 〒123-4567 (requires 〒 prefix or start-of-word 3-digit block)
    // Must NOT match the middle of a phone number like 03-1234-5678
    { name: 'POSTAL_CODE', pattern: /(?:〒|(?<=^|\s))\d{3}-\d{4}(?=\s|$)|〒\d{3}-\d{4}/g, priority: 70 },

    // Phone/fax: 03-1234-5678, 090-1234-5678, 0120-12-3456 (priority > POSTAL_CODE)
    { name: 'PHONE', pattern: /\b0\d{1,4}-\d{3,4}-\d{3,4}\b/g, priority: 72 },

    // Bank account numbers in context (after 口座 or 振込)
    { name: 'BANK_ACCOUNT', pattern: /(?<=口座[番号\s：:]*)\d{7,8}/g, priority: 60 },

    // Large standalone numbers (likely financial: 5+ digits with optional commas)
    { name: 'NUMBER_LARGE', pattern: /\b[\d,]{5,}\b/g, priority: 30 },

    // Model codes: DBA-KSP210, CBA-NHW20 etc.
    { name: 'MODEL_CODE', pattern: /\b[A-Z]{2,4}-[A-Z0-9]{3,}\b/g, priority: 55 },
  ].sort((a, b) => b.priority - a.priority);

  /**
   * Shield identifiers in text before translation.
   */
  shield(text: string): ShieldedText {
    let shielded = text;
    const tokens = new Map<string, string>();
    const identifiedItems: ShieldedText['identifiedItems'] = [];
    const counters: Record<string, number> = {};

    // Track ranges already shielded to prevent overlapping matches
    const shieldedRanges: Array<{ start: number; end: number }> = [];

    for (const { name, pattern } of this.PATTERNS) {
      // Clone regex to reset lastIndex
      const re = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = re.exec(shielded)) !== null) {
        const original = match[0];
        const start = match.index;
        const end = start + original.length;

        // Skip if this range overlaps with an already-shielded region
        if (this.overlapsShielded(start, end, shieldedRanges)) continue;

        // Generate UUID-based sentinel token (prevents collision with translation output)
        const uid = randomBytes(4).toString('hex');
        const sentinel = `__ID_${uid}_${name.toLowerCase()}__`;

        tokens.set(sentinel, original);
        identifiedItems.push({
          type: name,
          original,
          sentinel,
          position: start,
        });

        // Replace in text
        shielded = shielded.substring(0, start) + sentinel + shielded.substring(end);

        // Track the shielded range (using sentinel length)
        shieldedRanges.push({ start, end: start + sentinel.length });

        // Reset regex since we modified the string
        re.lastIndex = start + sentinel.length;
      }
    }

    if (identifiedItems.length > 0) {
      this.logger.debug(
        `Shielded ${identifiedItems.length} identifiers: ` +
          identifiedItems.map((i) => `${i.type}(${i.original})`).join(', '),
      );
    }

    return { shieldedText: shielded, tokens, identifiedItems };
  }

  /**
   * Restore shielded identifiers after translation.
   */
  unshield(translatedText: string, tokens: Map<string, string>): string {
    let restored = translatedText;

    for (const [sentinel, original] of tokens) {
      // Replace all occurrences (translation might duplicate tokens)
      while (restored.includes(sentinel)) {
        restored = restored.replace(sentinel, original);
      }
    }

    return restored;
  }

  /**
   * Check if a range overlaps any already-shielded range.
   */
  private overlapsShielded(
    start: number,
    end: number,
    ranges: Array<{ start: number; end: number }>,
  ): boolean {
    return ranges.some(
      (r) => start < r.end && end > r.start,
    );
  }
}
