import { Injectable, Logger } from '@nestjs/common';
import { UnderstoodBlock, KeyValuePair } from '../interfaces/understanding.interfaces';

/**
 * KeyValueDetector — detects label→value pairs using spatial proximity
 * and Japanese keyword patterns.
 *
 * Detection methods:
 * 1. label_colon_value: 車台番号：KSP210-0116561
 * 2. label_above_value: header row above data row
 * 3. label_left_value:  side-by-side layout
 * 4. keyword_anchor:    known Japanese business keywords
 */
@Injectable()
export class KeyValueDetector {
  private readonly logger = new Logger(KeyValueDetector.name);

  /** Known Japanese label keywords mapped to expected value patterns */
  private readonly KEYWORD_PATTERNS: Array<{
    keywords: string[];
    valuePattern?: RegExp;
    fieldHint: string;
  }> = [
    {
      keywords: ['車台番号', '車台No', 'シャシ', 'シャーシ'],
      valuePattern: /[A-Z][A-Z0-9]*-\d{4,}/,
      fieldHint: 'CHASSIS',
    },
    {
      keywords: ['請求書番号', '伝票番号', '注文番号', 'No.', 'No'],
      valuePattern: /[A-Z0-9\-]+/,
      fieldHint: 'INVOICE_NUMBER',
    },
    {
      keywords: ['合計', '総合計', '合計金額', '御請求金額'],
      valuePattern: /[¥￥]?\s?[\d,]+/,
      fieldHint: 'TOTAL',
    },
    {
      keywords: ['小計'],
      valuePattern: /[¥￥]?\s?[\d,]+/,
      fieldHint: 'SUBTOTAL',
    },
    {
      keywords: ['消費税', '税額', '税'],
      valuePattern: /[¥￥]?\s?[\d,]+/,
      fieldHint: 'TAX',
    },
    {
      keywords: ['日付', '発行日', '請求日', '取引年月日'],
      valuePattern: /\d{4}[\/-]\d{1,2}[\/-]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日|(令和|平成|昭和)\d+年/,
      fieldHint: 'DATE',
    },
    {
      keywords: ['買主', '購入者', '御中'],
      fieldHint: 'BUYER',
    },
    {
      keywords: ['売主', '販売者', '発行元'],
      fieldHint: 'SELLER',
    },
    {
      keywords: ['車名', '車種'],
      fieldHint: 'VEHICLE_NAME',
    },
    {
      keywords: ['型式', 'モデル'],
      valuePattern: /[A-Z0-9\-]+/,
      fieldHint: 'MODEL_CODE',
    },
    {
      keywords: ['振込先', '口座'],
      fieldHint: 'BANK_ACCOUNT',
    },
    {
      keywords: ['TEL', '電話', 'FAX'],
      valuePattern: /0\d{1,4}-\d{1,4}-\d{3,4}/,
      fieldHint: 'PHONE',
    },
    {
      keywords: ['〒', '郵便番号'],
      valuePattern: /\d{3}-\d{4}/,
      fieldHint: 'POSTAL_CODE',
    },
    {
      keywords: ['株式会社', '有限会社', '(株)', '（株）'],
      fieldHint: 'VENDOR',
    },
  ];

  /**
   * Detect key-value pairs from understood blocks.
   */
  detect(blocks: UnderstoodBlock[]): KeyValuePair[] {
    const pairs: KeyValuePair[] = [];

    // Method 1: label:value within single blocks
    for (const block of blocks) {
      const inlinePairs = this.detectInlinePairs(block);
      pairs.push(...inlinePairs);
    }

    // Method 2: label_left_value (adjacent blocks on same line)
    const leftValuePairs = this.detectLeftValuePairs(blocks);
    pairs.push(...leftValuePairs);

    // Method 3: label_above_value (stacked layout)
    const aboveValuePairs = this.detectAboveValuePairs(blocks);
    pairs.push(...aboveValuePairs);

    // Method 4: keyword_anchor (known keyword patterns)
    const anchorPairs = this.detectKeywordAnchors(blocks);
    pairs.push(...anchorPairs);

    // Deduplicate (same value from multiple methods)
    const deduped = this.deduplicatePairs(pairs);

    this.logger.debug(`Detected ${deduped.length} key-value pairs`);
    return deduped;
  }

  /**
   * Method 1: label:value or label：value within a single block.
   */
  private detectInlinePairs(block: UnderstoodBlock): KeyValuePair[] {
    const pairs: KeyValuePair[] = [];
    const text = block.normalizedText;

    // Split on colon patterns: ： : →
    const colonPatterns = /[:：→]\s*/;
    const parts = text.split(colonPatterns);

    if (parts.length >= 2) {
      const label = parts[0].trim();
      const value = parts.slice(1).join(':').trim();

      if (label.length > 0 && label.length < 30 && value.length > 0) {
        // Check if label matches any known keyword
        const match = this.matchKeyword(label);
        const confidence = match ? 0.9 : 0.6;

        pairs.push({
          label,
          value,
          sourceBlockId: block.blockId,
          page: block.page,
          labelBbox: block.bbox,
          confidence,
          detectionMethod: 'label_colon_value',
        });
      }
    }

    return pairs;
  }

  /**
   * Method 2: Side-by-side blocks where left is a label, right is a value.
   */
  private detectLeftValuePairs(blocks: UnderstoodBlock[]): KeyValuePair[] {
    const pairs: KeyValuePair[] = [];

    for (let i = 0; i < blocks.length; i++) {
      const left = blocks[i];
      if (!left.bbox) continue;

      // Check if this block looks like a label (short text, potentially a keyword)
      if (left.normalizedText.length > 30 || left.normalizedText.length < 1) continue;
      const keywordMatch = this.matchKeyword(left.normalizedText);
      if (!keywordMatch) continue;

      // Find the nearest block to the right on the same line
      for (let j = i + 1; j < blocks.length; j++) {
        const right = blocks[j];
        if (right.page !== left.page) break;
        if (!right.bbox) continue;

        // Same Y-level
        const yDiff = Math.abs(left.bbox[1] - right.bbox[1]);
        if (yDiff > 10) continue;

        // Right is to the right of left
        const gap = right.bbox[0] - left.bbox[2];
        if (gap < 0 || gap > 100) continue;

        pairs.push({
          label: left.normalizedText,
          value: right.normalizedText,
          sourceBlockId: left.blockId,
          page: left.page,
          labelBbox: left.bbox,
          valueBbox: right.bbox,
          confidence: 0.75,
          detectionMethod: 'label_left_value',
        });
        break;
      }
    }

    return pairs;
  }

  /**
   * Method 3: Label above value (header/data stacked layout).
   */
  private detectAboveValuePairs(blocks: UnderstoodBlock[]): KeyValuePair[] {
    const pairs: KeyValuePair[] = [];

    for (let i = 0; i < blocks.length; i++) {
      const above = blocks[i];
      if (!above.bbox) continue;

      // Check if this looks like a label
      if (above.normalizedText.length > 30 || above.normalizedText.length < 1) continue;
      const keywordMatch = this.matchKeyword(above.normalizedText);
      if (!keywordMatch) continue;

      // Find block directly below
      for (let j = i + 1; j < blocks.length; j++) {
        const below = blocks[j];
        if (below.page !== above.page) break;
        if (!below.bbox) continue;

        // Below is vertically adjacent
        const yGap = below.bbox[1] - above.bbox[3];
        if (yGap < 0 || yGap > 30) continue;

        // Horizontally aligned (similar X start)
        const xDiff = Math.abs(above.bbox[0] - below.bbox[0]);
        if (xDiff > 50) continue;

        pairs.push({
          label: above.normalizedText,
          value: below.normalizedText,
          sourceBlockId: above.blockId,
          page: above.page,
          labelBbox: above.bbox,
          valueBbox: below.bbox,
          confidence: 0.65,
          detectionMethod: 'label_above_value',
        });
        break;
      }
    }

    return pairs;
  }

  /**
   * Method 4: Find known keywords anywhere in text and extract adjacent values.
   */
  private detectKeywordAnchors(blocks: UnderstoodBlock[]): KeyValuePair[] {
    const pairs: KeyValuePair[] = [];

    for (const block of blocks) {
      const text = block.normalizedText;

      for (const pattern of this.KEYWORD_PATTERNS) {
        for (const keyword of pattern.keywords) {
          const idx = text.indexOf(keyword);
          if (idx === -1) continue;

          // Extract value after keyword
          const afterKeyword = text.substring(idx + keyword.length).trim();

          // Remove common separators
          const cleanValue = afterKeyword.replace(/^[:：\s]+/, '').trim();

          if (cleanValue.length === 0) continue;

          // If we have a value pattern, validate
          if (pattern.valuePattern && !pattern.valuePattern.test(cleanValue)) {
            // Try extracting just the matching part
            const match = cleanValue.match(pattern.valuePattern);
            if (!match) continue;

            pairs.push({
              label: keyword,
              value: match[0],
              sourceBlockId: block.blockId,
              page: block.page,
              labelBbox: block.bbox,
              confidence: 0.85,
              detectionMethod: 'keyword_anchor',
            });
          } else if (cleanValue.length < 100) {
            pairs.push({
              label: keyword,
              value: cleanValue.split(/\s/)[0] || cleanValue, // Take first token
              sourceBlockId: block.blockId,
              page: block.page,
              labelBbox: block.bbox,
              confidence: pattern.valuePattern ? 0.85 : 0.6,
              detectionMethod: 'keyword_anchor',
            });
          }
        }
      }
    }

    return pairs;
  }

  /**
   * Check if text matches any known keyword pattern.
   */
  private matchKeyword(text: string): { keywords: string[]; fieldHint: string } | null {
    const cleanText = text.trim();
    for (const pattern of this.KEYWORD_PATTERNS) {
      for (const keyword of pattern.keywords) {
        if (cleanText.includes(keyword)) return pattern;
      }
    }
    return null;
  }

  /**
   * Remove duplicate pairs (same label+value, keep highest confidence).
   */
  private deduplicatePairs(pairs: KeyValuePair[]): KeyValuePair[] {
    const map = new Map<string, KeyValuePair>();

    for (const pair of pairs) {
      const key = `${pair.label}||${pair.value}||${pair.page}`;
      const existing = map.get(key);

      if (!existing || pair.confidence > existing.confidence) {
        map.set(key, pair);
      }
    }

    return Array.from(map.values());
  }
}
