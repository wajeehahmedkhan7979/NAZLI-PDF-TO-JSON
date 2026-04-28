import { Injectable, Logger } from '@nestjs/common';
import {
  UnderstoodBlock,
  KeyValuePair,
  FieldCandidate,
  FieldType,
  SectionType,
} from '../interfaces/understanding.interfaces';

/**
 * FieldCandidateBuilder — produces ranked field candidates from understood blocks.
 *
 * This layer decouples extraction from schema mapping:
 * - Extraction produces blocks
 * - Understanding enriches blocks with sections, key-value pairs
 * - FieldCandidateBuilder produces typed, ranked candidates
 * - Schema mapper consumes candidates without needing to understand extraction details
 *
 * Multiple candidates per field type are allowed; the mapper picks the best one.
 */
@Injectable()
export class FieldCandidateBuilder {
  private readonly logger = new Logger(FieldCandidateBuilder.name);

  /** Pattern-based field detection rules */
  private readonly FIELD_PATTERNS: Array<{
    fieldType: FieldType;
    patterns: RegExp[];
    labelHints: string[];
    confidence: number;
  }> = [
    {
      fieldType: 'VIN',
      patterns: [/^[A-HJ-NPR-Z0-9]{17}$/],
      labelHints: ['VIN', 'vin'],
      confidence: 0.95,
    },
    {
      fieldType: 'CHASSIS',
      patterns: [/^[A-Z][A-Z0-9]{2,}-\d{4,}$/],
      labelHints: ['車台番号', '車台No', 'シャシ', 'シャーシ', 'chassis'],
      confidence: 0.9,
    },
    {
      fieldType: 'DATE',
      patterns: [
        /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/,
        /^\d{4}年\d{1,2}月\d{1,2}日$/,
        /^(令和|平成|昭和)\d+年\d+月\d+日$/,
      ],
      labelHints: ['日付', '発行日', '請求日', '取引年月日', 'date'],
      confidence: 0.85,
    },
    {
      fieldType: 'CURRENCY_AMOUNT',
      patterns: [/^[¥￥]?\s?[\d,]{3,}$/],
      labelHints: ['金額', '額', '価格'],
      confidence: 0.7,
    },
    {
      fieldType: 'TOTAL',
      patterns: [/^[¥￥]?\s?[\d,]{3,}$/],
      labelHints: ['合計', '総合計', '合計金額', '御請求金額', 'total'],
      confidence: 0.85,
    },
    {
      fieldType: 'SUBTOTAL',
      patterns: [/^[¥￥]?\s?[\d,]{3,}$/],
      labelHints: ['小計', 'subtotal'],
      confidence: 0.85,
    },
    {
      fieldType: 'TAX',
      patterns: [/^[¥￥]?\s?[\d,]{3,}$/],
      labelHints: ['消費税', '税額', '税', 'tax'],
      confidence: 0.85,
    },
    {
      fieldType: 'INVOICE_NUMBER',
      patterns: [/^[A-Z]{0,3}\d{5,}$/, /^[A-Z0-9]+-\d+$/],
      labelHints: ['請求書番号', '伝票番号', '注文番号', 'No.', 'invoice'],
      confidence: 0.8,
    },
    {
      fieldType: 'VENDOR',
      patterns: [/株式会社|有限会社|（株）|\(株\)/],
      labelHints: ['発行元', '売主', '販売者'],
      confidence: 0.8,
    },
    {
      fieldType: 'CLIENT',
      patterns: [/御中|様/],
      labelHints: ['御中', '買主', '購入者'],
      confidence: 0.75,
    },
    {
      fieldType: 'VEHICLE_NAME',
      patterns: [],
      labelHints: ['車名', '車種', '品名'],
      confidence: 0.7,
    },
    {
      fieldType: 'MODEL_CODE',
      patterns: [/^[A-Z]{2,}\d{2,}[A-Z]?$/],
      labelHints: ['型式', 'モデル', 'model'],
      confidence: 0.8,
    },
    {
      fieldType: 'PHONE',
      patterns: [/^0\d{1,4}-\d{1,4}-\d{3,4}$/],
      labelHints: ['TEL', '電話', 'FAX', 'tel', 'fax'],
      confidence: 0.85,
    },
    {
      fieldType: 'POSTAL_CODE',
      patterns: [/^〒?\d{3}-\d{4}$/],
      labelHints: ['〒', '郵便番号'],
      confidence: 0.9,
    },
    {
      fieldType: 'BANK_ACCOUNT',
      patterns: [/^\d{7,8}$/],
      labelHints: ['口座', '振込先'],
      confidence: 0.6, // Low default — needs label context
    },
    {
      fieldType: 'LOT_NUMBER',
      patterns: [/^\d{1,5}$/],
      labelHints: ['出品No', 'ロット', 'lot'],
      confidence: 0.6,
    },
    {
      fieldType: 'AUCTION_FEE',
      patterns: [/^[\d,]{3,}$/],
      labelHints: ['落札料', 'オークション手数料', '手数料'],
      confidence: 0.7,
    },
    {
      fieldType: 'RECYCLE_FEE',
      patterns: [/^[\d,]{3,}$/],
      labelHints: ['リサイクル', 'リサイクル料', '自動車リサイクル'],
      confidence: 0.7,
    },
  ];

  /**
   * Build field candidates from understood blocks and detected key-value pairs.
   */
  buildCandidates(
    blocks: UnderstoodBlock[],
    kvPairs: KeyValuePair[],
  ): FieldCandidate[] {
    const candidates: FieldCandidate[] = [];

    // Source 1: Key-value pairs → strongest signal
    for (const kv of kvPairs) {
      const kvCandidates = this.candidatesFromKVPair(kv, blocks);
      candidates.push(...kvCandidates);
    }

    // Source 2: Pattern matching on standalone blocks
    for (const block of blocks) {
      const patternCandidates = this.candidatesFromPattern(block);
      candidates.push(...patternCandidates);
    }

    // Deduplicate and rank
    const ranked = this.rankCandidates(candidates);

    this.logger.debug(
      `Built ${ranked.length} field candidates from ${kvPairs.length} KV pairs and ${blocks.length} blocks`,
    );

    return ranked;
  }

  /**
   * Generate candidates from a detected key-value pair.
   */
  private candidatesFromKVPair(
    kv: KeyValuePair,
    blocks: UnderstoodBlock[],
  ): FieldCandidate[] {
    const candidates: FieldCandidate[] = [];
    const sourceBlock = blocks.find((b) => b.blockId === kv.sourceBlockId);
    const section = sourceBlock?.sectionType || 'UNKNOWN';

    for (const rule of this.FIELD_PATTERNS) {
      // Check if the KV label matches this field's label hints
      const labelMatch = rule.labelHints.some((hint) =>
        kv.label.includes(hint),
      );
      if (!labelMatch) continue;

      // Check if value matches the pattern (if patterns exist)
      let patternMatch = rule.patterns.length === 0; // No patterns = always match on label
      let valueFormatScore = rule.patterns.length === 0 ? 0.5 : 0;
      for (const pattern of rule.patterns) {
        if (pattern.test(kv.value.trim())) {
          patternMatch = true;
          valueFormatScore = 1.0;
          break;
        }
      }

      if (!patternMatch) continue;

      // Decomposed confidence
      const labelMatchScore = kv.confidence > 0.8 ? 1.0 : kv.confidence;
      const sectionAlignmentScore = this.sectionAlignment(rule.fieldType, section);
      const spatialConsistencyScore = kv.detectionMethod === 'label_colon_value' ? 0.95 :
        kv.detectionMethod === 'label_left_value' ? 0.85 :
        kv.detectionMethod === 'label_above_value' ? 0.75 : 0.6;

      // Weighted composite
      const confidence = Math.min(0.98,
        labelMatchScore * 0.30 +
        sectionAlignmentScore * 0.25 +
        spatialConsistencyScore * 0.15 +
        valueFormatScore * 0.30
      );

      candidates.push({
        fieldType: rule.fieldType,
        value: kv.value.trim(),
        sourceBlockId: kv.sourceBlockId,
        page: kv.page,
        confidence,
        confidenceBreakdown: {
          labelMatch: parseFloat(labelMatchScore.toFixed(3)),
          sectionAlignment: parseFloat(sectionAlignmentScore.toFixed(3)),
          spatialConsistency: parseFloat(spatialConsistencyScore.toFixed(3)),
          valueFormat: parseFloat(valueFormatScore.toFixed(3)),
        },
        context: {
          section,
          nearbyLabels: [kv.label],
          kvPair: kv,
        },
      });
    }

    return candidates;
  }

  /**
   * Generate candidates by pattern matching block text directly.
   */
  private candidatesFromPattern(block: UnderstoodBlock): FieldCandidate[] {
    const candidates: FieldCandidate[] = [];
    const text = block.normalizedText.trim();

    if (!text || text.length > 200) return candidates;

    for (const rule of this.FIELD_PATTERNS) {
      for (const pattern of rule.patterns) {
        const match = text.match(pattern);
        if (!match) continue;

        // Decomposed confidence for pattern-only matches
        const labelMatchScore = 0.0; // No label context
        const sectionAlignmentScore = this.sectionAlignment(rule.fieldType, block.sectionType);
        const spatialConsistencyScore = 0.5; // Unknown without KV pair
        const valueFormatScore = 1.0; // Pattern matched fully

        // Pattern-only matches get lower weight on label (it's absent)
        const confidence = Math.min(0.85,
          labelMatchScore * 0.10 +
          sectionAlignmentScore * 0.35 +
          spatialConsistencyScore * 0.15 +
          valueFormatScore * 0.40
        );

        candidates.push({
          fieldType: rule.fieldType,
          value: match[0],
          sourceBlockId: block.blockId,
          page: block.page,
          confidence,
          confidenceBreakdown: {
            labelMatch: 0,
            sectionAlignment: parseFloat(sectionAlignmentScore.toFixed(3)),
            spatialConsistency: 0.5,
            valueFormat: 1.0,
          },
          context: {
            section: block.sectionType,
            nearbyLabels: [],
          },
        });
      }
    }

    return candidates;
  }

  /**
   * Deduplicate candidates and rank by confidence.
   * Keep multiple candidates per field type (mapper will pick).
   */
  private rankCandidates(candidates: FieldCandidate[]): FieldCandidate[] {
    // Group by fieldType + value to deduplicate exact matches
    const map = new Map<string, FieldCandidate>();

    for (const c of candidates) {
      const key = `${c.fieldType}||${c.value}||${c.page}`;
      const existing = map.get(key);

      if (!existing || c.confidence > existing.confidence) {
        map.set(key, c);
      }
    }

    // Sort by confidence descending within each field type
    const result = Array.from(map.values());
    result.sort((a, b) => {
      if (a.fieldType !== b.fieldType) return a.fieldType.localeCompare(b.fieldType);
      return b.confidence - a.confidence;
    });

    return result;
  }

  /**
   * Score how well a field type aligns with the section it was found in.
   * A TOTAL in TOTALS section scores 1.0; a TOTAL in HEADER scores 0.2.
   */
  private sectionAlignment(fieldType: FieldType, section: SectionType | string): number {
    const expected: Record<string, string[]> = {
      VIN: ['VEHICLE_INFO', 'HEADER'],
      CHASSIS: ['VEHICLE_INFO', 'HEADER'],
      TOTAL: ['TOTALS'],
      SUBTOTAL: ['TOTALS', 'LINE_ITEMS'],
      TAX: ['TOTALS'],
      DATE: ['HEADER', 'FOOTER'],
      INVOICE_NUMBER: ['HEADER'],
      VENDOR: ['HEADER', 'PARTIES'],
      CLIENT: ['HEADER', 'PARTIES'],
      VEHICLE_NAME: ['VEHICLE_INFO', 'LINE_ITEMS'],
      MODEL_CODE: ['VEHICLE_INFO'],
      CURRENCY_AMOUNT: ['LINE_ITEMS', 'TOTALS'],
      LOT_NUMBER: ['HEADER'],
      AUCTION_FEE: ['TOTALS', 'LINE_ITEMS'],
      RECYCLE_FEE: ['TOTALS', 'LINE_ITEMS'],
      BANK_ACCOUNT: ['FOOTER', 'NOTES'],
      PHONE: ['HEADER', 'FOOTER'],
      POSTAL_CODE: ['HEADER', 'FOOTER'],
    };

    const sections = expected[fieldType];
    if (!sections) return 0.5; // Unknown field type
    if (section === 'UNKNOWN') return 0.4; // Can't tell
    if (sections.includes(section as string)) return 1.0; // Perfect match
    return 0.2; // Wrong section
  }
}
