import { Injectable, Logger } from '@nestjs/common';
import { UnderstoodBlock, SectionType } from '../interfaces/understanding.interfaces';

/**
 * SectionClassifier — assigns semantic section types to blocks.
 *
 * Uses a combination of:
 * 1. Position heuristics (top = header, bottom = totals)
 * 2. Keyword anchors (Japanese business terms)
 * 3. Block type from Marker (SectionHeader, Table, Form)
 * 4. Content pattern matching
 */
@Injectable()
export class SectionClassifier {
  private readonly logger = new Logger(SectionClassifier.name);

  /** Keyword → section mapping */
  private readonly SECTION_KEYWORDS: Array<{
    section: SectionType;
    keywords: string[];
  }> = [
    {
      section: 'HEADER',
      keywords: [
        '請求書', '計算書', 'オークション計算書', '明細書',
        '納品書', '見積書', '注文書', '受領書',
      ],
    },
    {
      section: 'PARTIES',
      keywords: [
        '御中', '様', '殿', '宛',
        '株式会社', '有限会社', '(株)', '（株）',
        '発行元', '売主', '買主', '購入者', '販売者',
        'NAZLI', 'TRADING',
      ],
    },
    {
      section: 'VEHICLE_INFO',
      keywords: [
        '車台番号', '車名', '型式', '年式', '走行距離',
        '排気量', '車両', 'VIN', 'シャシ',
      ],
    },
    {
      section: 'LINE_ITEMS',
      keywords: [
        '品名', '摘要', '数量', '単価', '金額',
        '品目', '項目', '明細', '内容', '落札価格',
        '成約', '商談', 'リサイクル', '自動車税', '落札料',
      ],
    },
    {
      section: 'TOTALS',
      keywords: [
        '合計', '小計', '消費税', '税額', '総合計',
        '御請求金額', '振込金額', 'TOTAL', '支払合計',
        '決済', '精算',
      ],
    },
    {
      section: 'FOOTER',
      keywords: [
        '振込先', '口座', '銀行', '支店',
        'お支払い', '備考', '注意事項',
      ],
    },
    {
      section: 'NOTES',
      keywords: [
        '備考', '注記', '※', '注意', 'メモ',
      ],
    },
  ];

  /**
   * Classify all blocks into semantic sections.
   */
  classify(blocks: UnderstoodBlock[]): UnderstoodBlock[] {
    if (blocks.length === 0) return [];

    // Group blocks by page
    const byPage = new Map<number, UnderstoodBlock[]>();
    for (const b of blocks) {
      if (!byPage.has(b.page)) byPage.set(b.page, []);
      byPage.get(b.page)!.push(b);
    }

    const classified: UnderstoodBlock[] = [];

    for (const [page, pageBlocks] of byPage) {
      const pageHeight = this.estimatePageHeight(pageBlocks);
      const classifiedPage = this.classifyPage(pageBlocks, pageHeight);
      classified.push(...classifiedPage);
    }

    // Log distribution
    const sectionCounts = new Map<string, number>();
    for (const b of classified) {
      sectionCounts.set(b.sectionType, (sectionCounts.get(b.sectionType) || 0) + 1);
    }
    this.logger.debug(
      `Section classification: ${Array.from(sectionCounts.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    );

    return classified;
  }

  /**
   * Classify blocks within a single page.
   */
  private classifyPage(
    blocks: UnderstoodBlock[],
    pageHeight: number,
  ): UnderstoodBlock[] {
    return blocks.map((block) => {
      const { section, confidence } = this.classifyBlock(block, pageHeight);
      return {
        ...block,
        sectionType: section,
        sectionConfidence: confidence,
      };
    });
  }

  /**
   * Classify a single block.
   */
  private classifyBlock(
    block: UnderstoodBlock,
    pageHeight: number,
  ): { section: SectionType; confidence: number } {
    // Strategy 1: Block type from Marker
    const markerSection = this.classifyByBlockType(block);
    if (markerSection.confidence > 0.8) return markerSection;

    // Strategy 2: Keyword matching
    const keywordSection = this.classifyByKeywords(block);
    if (keywordSection.confidence > 0.7) return keywordSection;

    // Strategy 3: Position heuristics
    const positionSection = this.classifyByPosition(block, pageHeight);

    // Strategy 4: Content pattern matching
    const patternSection = this.classifyByPattern(block);

    // Pick highest confidence
    const candidates = [markerSection, keywordSection, positionSection, patternSection].filter(
      (c) => c.section !== 'UNKNOWN',
    );

    if (candidates.length === 0) {
      return { section: 'UNKNOWN', confidence: 0.1 };
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates[0];
  }

  /**
   * Classify by Marker's block_type.
   */
  private classifyByBlockType(
    block: UnderstoodBlock,
  ): { section: SectionType; confidence: number } {
    switch (block.blockType) {
      case 'SectionHeader':
        return { section: 'HEADER', confidence: 0.85 };
      case 'PageHeader':
        return { section: 'HEADER', confidence: 0.9 };
      case 'PageFooter':
        return { section: 'FOOTER', confidence: 0.9 };
      case 'Table':
      case 'TableGroup':
        return { section: 'TABLE', confidence: 0.85 };
      case 'Form':
        return { section: 'FORM', confidence: 0.85 };
      case 'Footnote':
        return { section: 'NOTES', confidence: 0.8 };
      default:
        return { section: 'UNKNOWN', confidence: 0 };
    }
  }

  /**
   * Classify by keyword presence in text.
   */
  private classifyByKeywords(
    block: UnderstoodBlock,
  ): { section: SectionType; confidence: number } {
    const text = block.normalizedText;
    if (!text || text.length === 0) return { section: 'UNKNOWN', confidence: 0 };

    let bestSection: SectionType = 'UNKNOWN';
    let bestScore = 0;

    for (const entry of this.SECTION_KEYWORDS) {
      let score = 0;
      for (const keyword of entry.keywords) {
        if (text.includes(keyword)) {
          score += keyword.length; // Longer keyword matches are more specific
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestSection = entry.section;
      }
    }

    // Normalize score to confidence
    const confidence = bestScore > 0 ? Math.min(0.9, 0.5 + bestScore * 0.05) : 0;
    return { section: bestSection, confidence };
  }

  /**
   * Classify by vertical position on the page.
   */
  private classifyByPosition(
    block: UnderstoodBlock,
    pageHeight: number,
  ): { section: SectionType; confidence: number } {
    if (!block.bbox || pageHeight === 0) return { section: 'UNKNOWN', confidence: 0 };

    const yCenter = (block.bbox[1] + block.bbox[3]) / 2;
    const relativeY = yCenter / pageHeight;

    if (relativeY < 0.15) {
      return { section: 'HEADER', confidence: 0.5 };
    }
    if (relativeY > 0.85) {
      return { section: 'FOOTER', confidence: 0.5 };
    }
    if (relativeY > 0.7) {
      return { section: 'TOTALS', confidence: 0.35 };
    }

    return { section: 'UNKNOWN', confidence: 0 };
  }

  /**
   * Classify by content patterns (numbers, codes, etc.).
   */
  private classifyByPattern(
    block: UnderstoodBlock,
  ): { section: SectionType; confidence: number } {
    const text = block.normalizedText;
    if (!text) return { section: 'UNKNOWN', confidence: 0 };

    // Chassis pattern → VEHICLE_INFO
    if (/[A-Z][A-Z0-9]*-\d{4,}/.test(text)) {
      return { section: 'VEHICLE_INFO', confidence: 0.7 };
    }

    // Currency amounts → might be TOTALS or LINE_ITEMS
    if (/[¥￥]\s?[\d,]{4,}/.test(text)) {
      return { section: 'TOTALS', confidence: 0.4 };
    }

    // Date pattern → could be HEADER
    if (/\d{4}年\d{1,2}月\d{1,2}日/.test(text)) {
      return { section: 'HEADER', confidence: 0.4 };
    }

    return { section: 'UNKNOWN', confidence: 0 };
  }

  /**
   * Estimate page height from block positions.
   */
  private estimatePageHeight(blocks: UnderstoodBlock[]): number {
    let maxY = 0;
    for (const b of blocks) {
      if (b.bbox && b.bbox[3] > maxY) maxY = b.bbox[3];
    }
    return maxY || 800; // Default A4-ish
  }
}
