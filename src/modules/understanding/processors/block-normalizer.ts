import { Injectable, Logger } from '@nestjs/common';
import { ExtractionBlock } from '../../extraction/interfaces/extraction-backend.interface';
import { UnderstoodBlock, SectionType } from '../interfaces/understanding.interfaces';

/**
 * BlockNormalizer — first stage of the understanding layer.
 *
 * Responsibilities:
 * 1. Merge fragmented OCR lines (same Y-coordinate, adjacent X)
 * 2. Deduplicate overlapping blocks
 * 3. Fix reading order within merged blocks
 * 4. Normalize whitespace and fullwidth → halfwidth characters
 */
@Injectable()
export class BlockNormalizer {
  private readonly logger = new Logger(BlockNormalizer.name);

  /**
   * Normalize and merge a list of extraction blocks.
   */
  normalize(blocks: ExtractionBlock[]): UnderstoodBlock[] {
    if (!blocks || blocks.length === 0) return [];

    // Step 1: Normalize text content
    let normalized = blocks.map((b) => this.normalizeBlock(b));

    // Step 2: Deduplicate overlapping blocks
    normalized = this.deduplicateBlocks(normalized);

    // Step 3: Merge adjacent fragments on the same line
    normalized = this.mergeFragments(normalized);

    // Step 4: Fix reading order (top-to-bottom, left-to-right within pages)
    normalized = this.sortByReadingOrder(normalized);

    this.logger.debug(
      `Normalized ${blocks.length} blocks → ${normalized.length} blocks ` +
        `(${blocks.length - normalized.length} merged/deduped)`,
    );

    return normalized;
  }

  /**
   * Normalize a single block's text content.
   */
  private normalizeBlock(block: ExtractionBlock): UnderstoodBlock {
    return {
      ...block,
      normalizedText: this.normalizeText(block.text),
      sectionType: 'UNKNOWN' as SectionType,
      sectionConfidence: 0,
      wasMerged: false,
    };
  }

  /**
   * Fullwidth → halfwidth, collapse whitespace, trim.
   */
  private normalizeText(text: string): string {
    if (!text) return '';

    let result = text;

    // Fullwidth ASCII → halfwidth (except Japanese chars)
    result = result.replace(/[\uff01-\uff5e]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    );

    // Fullwidth space → regular space
    result = result.replace(/\u3000/g, ' ');

    // Halfwidth katakana normalization (ｱ→ア etc.) - common in auction sheets
    // This is a simplified version; production might use a full normalization library
    result = this.normalizeHalfwidthKatakana(result);

    // Collapse multiple spaces
    result = result.replace(/\s+/g, ' ');

    return result.trim();
  }

  /**
   * Basic halfwidth katakana → fullwidth katakana conversion.
   */
  private normalizeHalfwidthKatakana(text: string): string {
    // Map of halfwidth katakana to fullwidth
    const hwToFw: Record<string, string> = {
      'ｱ': 'ア', 'ｲ': 'イ', 'ｳ': 'ウ', 'ｴ': 'エ', 'ｵ': 'オ',
      'ｶ': 'カ', 'ｷ': 'キ', 'ｸ': 'ク', 'ｹ': 'ケ', 'ｺ': 'コ',
      'ｻ': 'サ', 'ｼ': 'シ', 'ｽ': 'ス', 'ｾ': 'セ', 'ｿ': 'ソ',
      'ﾀ': 'タ', 'ﾁ': 'チ', 'ﾂ': 'ツ', 'ﾃ': 'テ', 'ﾄ': 'ト',
      'ﾅ': 'ナ', 'ﾆ': 'ニ', 'ﾇ': 'ヌ', 'ﾈ': 'ネ', 'ﾉ': 'ノ',
      'ﾊ': 'ハ', 'ﾋ': 'ヒ', 'ﾌ': 'フ', 'ﾍ': 'ヘ', 'ﾎ': 'ホ',
      'ﾏ': 'マ', 'ﾐ': 'ミ', 'ﾑ': 'ム', 'ﾒ': 'メ', 'ﾓ': 'モ',
      'ﾔ': 'ヤ', 'ﾕ': 'ユ', 'ﾖ': 'ヨ',
      'ﾗ': 'ラ', 'ﾘ': 'リ', 'ﾙ': 'ル', 'ﾚ': 'レ', 'ﾛ': 'ロ',
      'ﾜ': 'ワ', 'ﾝ': 'ン',
      'ﾞ': '゛', 'ﾟ': '゜',
      'ｰ': 'ー', '｡': '。', '｢': '「', '｣': '」', '､': '、', '･': '・',
    };

    let result = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (hwToFw[ch]) {
        // Check for dakuten/handakuten combining
        const next = text[i + 1];
        if (next === 'ﾞ' && hwToFw[ch]) {
          result += this.addDakuten(hwToFw[ch]);
          i++;
        } else if (next === 'ﾟ' && hwToFw[ch]) {
          result += this.addHandakuten(hwToFw[ch]);
          i++;
        } else {
          result += hwToFw[ch];
        }
      } else {
        result += ch;
      }
    }
    return result;
  }

  private addDakuten(char: string): string {
    const map: Record<string, string> = {
      'カ': 'ガ', 'キ': 'ギ', 'ク': 'グ', 'ケ': 'ゲ', 'コ': 'ゴ',
      'サ': 'ザ', 'シ': 'ジ', 'ス': 'ズ', 'セ': 'ゼ', 'ソ': 'ゾ',
      'タ': 'ダ', 'チ': 'ヂ', 'ツ': 'ヅ', 'テ': 'デ', 'ト': 'ド',
      'ハ': 'バ', 'ヒ': 'ビ', 'フ': 'ブ', 'ヘ': 'ベ', 'ホ': 'ボ',
      'ウ': 'ヴ',
    };
    return map[char] || char + '゛';
  }

  private addHandakuten(char: string): string {
    const map: Record<string, string> = {
      'ハ': 'パ', 'ヒ': 'ピ', 'フ': 'プ', 'ヘ': 'ペ', 'ホ': 'ポ',
    };
    return map[char] || char + '゜';
  }

  /**
   * Remove blocks that significantly overlap spatially.
   * Keep the one with higher confidence.
   */
  private deduplicateBlocks(blocks: UnderstoodBlock[]): UnderstoodBlock[] {
    if (blocks.length < 2) return blocks;

    const kept: UnderstoodBlock[] = [];
    const removed = new Set<number>();

    for (let i = 0; i < blocks.length; i++) {
      if (removed.has(i)) continue;

      const a = blocks[i];
      let best = a;

      for (let j = i + 1; j < blocks.length; j++) {
        if (removed.has(j)) continue;

        const b = blocks[j];

        // Must be on the same page
        if (a.page !== b.page) continue;

        // Check spatial overlap
        if (a.bbox && b.bbox && this.overlapRatio(a.bbox, b.bbox) > 0.7) {
          // Check text similarity
          if (this.textSimilarity(a.normalizedText, b.normalizedText) > 0.8) {
            // Keep the one with higher confidence
            if (b.confidence > best.confidence) {
              removed.add(i);
              best = b;
            } else {
              removed.add(j);
            }
          }
        }
      }

      if (!removed.has(i)) {
        kept.push(best);
      }
    }

    if (removed.size > 0) {
      this.logger.debug(`Deduplicated ${removed.size} overlapping blocks`);
    }

    return kept;
  }

  /**
   * Merge blocks that appear to be fragments of the same line.
   * Criteria: same page, similar Y coordinate, adjacent X coordinates.
   */
  private mergeFragments(blocks: UnderstoodBlock[]): UnderstoodBlock[] {
    const result: UnderstoodBlock[] = [];
    const merged = new Set<number>();

    // Group by page
    const byPage = new Map<number, UnderstoodBlock[]>();
    for (const b of blocks) {
      if (!byPage.has(b.page)) byPage.set(b.page, []);
      byPage.get(b.page)!.push(b);
    }

    for (const [, pageBlocks] of byPage) {
      // Sort by Y then X within page
      const sorted = [...pageBlocks].sort((a, b) => {
        const ay = a.bbox ? a.bbox[1] : 0;
        const by = b.bbox ? b.bbox[1] : 0;
        if (Math.abs(ay - by) < 5) {
          const ax = a.bbox ? a.bbox[0] : 0;
          const bx = b.bbox ? b.bbox[0] : 0;
          return ax - bx;
        }
        return ay - by;
      });

      for (let i = 0; i < sorted.length; i++) {
        if (merged.has(i)) continue;

        const current = { ...sorted[i] };
        const mergedIds: string[] = [];

        // Look for adjacent fragments
        for (let j = i + 1; j < sorted.length; j++) {
          if (merged.has(j)) continue;

          const next = sorted[j];
          if (this.shouldMerge(current, next)) {
            // Merge text
            current.normalizedText += ' ' + next.normalizedText;
            current.text += ' ' + next.text;
            mergedIds.push(next.blockId);
            merged.add(j);

            // Expand bbox
            if (current.bbox && next.bbox) {
              current.bbox = [
                Math.min(current.bbox[0], next.bbox[0]),
                Math.min(current.bbox[1], next.bbox[1]),
                Math.max(current.bbox[2], next.bbox[2]),
                Math.max(current.bbox[3], next.bbox[3]),
              ];
            }

            // Average confidence
            current.confidence = (current.confidence + next.confidence) / 2;
          }
        }

        if (mergedIds.length > 0) {
          current.wasMerged = true;
          current.mergedFrom = [current.blockId, ...mergedIds];
        }

        result.push(current);
      }
    }

    return result;
  }

  /**
   * Determine if two blocks should be merged (same logical line).
   */
  private shouldMerge(a: UnderstoodBlock, b: UnderstoodBlock): boolean {
    if (a.page !== b.page) return false;
    if (!a.bbox || !b.bbox) return false;

    // Same Y-level (within 5px tolerance)
    const yDiff = Math.abs(a.bbox[1] - b.bbox[1]);
    if (yDiff > 5) return false;

    // Adjacent X (gap < 30px)
    const aRight = a.bbox[2];
    const bLeft = b.bbox[0];
    const gap = bLeft - aRight;
    if (gap < 0 || gap > 30) return false;

    // Both are text-type blocks
    const textTypes = ['Text', 'Span', 'Line'];
    if (!textTypes.includes(a.blockType) || !textTypes.includes(b.blockType)) return false;

    return true;
  }

  /**
   * Sort blocks by reading order: top-to-bottom, left-to-right.
   */
  private sortByReadingOrder(blocks: UnderstoodBlock[]): UnderstoodBlock[] {
    return [...blocks].sort((a, b) => {
      // First by page
      if (a.page !== b.page) return a.page - b.page;

      // Then by Y position
      const ay = a.bbox ? a.bbox[1] : a.position * 100;
      const by = b.bbox ? b.bbox[1] : b.position * 100;
      if (Math.abs(ay - by) > 10) return ay - by;

      // Then by X position
      const ax = a.bbox ? a.bbox[0] : 0;
      const bx = b.bbox ? b.bbox[0] : 0;
      return ax - bx;
    }).map((block, idx) => ({
      ...block,
      position: idx,
    }));
  }

  /**
   * Calculate overlap ratio between two bboxes.
   */
  private overlapRatio(a: number[], b: number[]): number {
    const xOverlap = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const yOverlap = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const overlapArea = xOverlap * yOverlap;

    const aArea = (a[2] - a[0]) * (a[3] - a[1]);
    const bArea = (b[2] - b[0]) * (b[3] - b[1]);
    const minArea = Math.min(aArea, bArea);

    return minArea > 0 ? overlapArea / minArea : 0;
  }

  /**
   * Simple text similarity using character overlap.
   */
  private textSimilarity(a: string, b: string): number {
    if (!a && !b) return 1;
    if (!a || !b) return 0;

    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;

    if (longer.length === 0) return 1;

    let matches = 0;
    for (const ch of shorter) {
      if (longer.includes(ch)) matches++;
    }

    return matches / longer.length;
  }
}
