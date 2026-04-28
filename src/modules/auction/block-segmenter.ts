import { Injectable, Logger } from '@nestjs/common';

/**
 * Block Segmenter — Groups raw PDF text lines into logical vehicle record blocks.
 *
 * Strategy:
 * 1. Forward-scan for auction prefix lines (TC-web, ANS, USS, standalone venue names)
 * 2. Validate blocks by detecting chassis pattern within each block
 * 3. Filter out document header/footer (bank info, column headers, summary rows)
 *
 * A new block starts when:
 * - Line starts with known auction prefix (TC-web, ANS, USS)
 * - Line is a standalone venue name (横浜, 兵庫, etc.) not preceded by a digit
 * - Line contains chassis AND current block already has a chassis (safety split)
 */
@Injectable()
export class BlockSegmenter {
  private readonly logger = new Logger(BlockSegmenter.name);

  // Known auction platform prefixes
  private readonly AUCTION_PREFIXES = ['TC-web', 'ANS', 'USS'];

  // Known venue/area names (standalone lines indicating block start)
  private readonly VENUE_NAMES = [
    '横浜', '兵庫', '東京', '名古屋', '大阪', '福岡', '札幌',
    '仙台', '広島', '北海道', '静岡', '新潟', '岡山', '群馬',
    '東北', '関東', '中部', '関西', '九州', 'Tohoku', 'Tokyo', 'Kanto', 'Kansai'
  ];

  // Footer/header markers to exclude from vehicle parsing
  private readonly FOOTER_MARKERS = [
    '三菱ＵＦＪ', '普通', '口座名', '振込先', '下段', '消費税',
    '開催日', '出品No', '会場', '年', '式', '車', '成約', '落札',
    '御支払', '御請求', '御取引', '本日差引', '前回残高', '入出金',
    '差引御請求', '今回取引', 'その他取引', '前回残高', '税率区分',
    '登録番号', '発行元', 'ＡＡ回', 'FAX', '電話', '〒', '神奈川県',
    'ｵｰｸｼｮﾝ計算書', 'オークション計算書',
    'ﾘｻｲｸﾙ', '預託金', '自税', '相当額', '出品料', '成約料', '落札料',
    '備  考', '備考',
  ];

  // Strings indicating this is a transport or summary line, not a vehicle
  private readonly TRANSPORT_KEYWORDS = [
    '輸送料', '輸送', '送料', '合計', '合算', '合計金額', '振込', '銀行', '支店',
    'その他', '非課税'
  ];

  // Chassis regex: [Letter(s)][AlphaNum]-[Digits]
  private readonly CHASSIS_REGEX = /^(\d+)?([A-Z][A-Z0-9]*-\d+)$/;
  private readonly CHASSIS_INLINE_REGEX = /([A-Z][A-Z0-9]*-\d{4,})/;

  /**
   * Segment raw text into vehicle record blocks.
   * @param rawText Full extracted PDF text
   * @returns Array of line-arrays, each representing one vehicle record
   */
  segment(rawText: string): string[][] {
    const allLines = rawText.split('\n');

    // 1. Preprocess: trim, normalize full-width digits, tag
    const cleaned = this.preprocessLines(allLines);

    // 2. Filter out footer/header lines
    const dataLines = this.filterNonDataLines(cleaned);

    // 3. Forward-scan to group into blocks
    const rawBlocks = this.groupIntoBlocks(dataLines);

    // 4. Validate each block (must contain a chassis)
    const validBlocks = this.validateBlocks(rawBlocks);

    this.logger.log(`Segmented ${dataLines.length} lines → ${validBlocks.length} vehicle blocks`);

    return validBlocks;
  }

  /**
   * Preprocess: trim whitespace, normalize full-width → half-width numbers,
   * remove empty lines, preserve order.
   */
  private preprocessLines(lines: string[]): string[] {
    return lines
      .map(line => this.normalizeFullWidth(line.trim()))
      .filter(line => line.length > 0);
  }

  /**
   * Convert full-width digits (０-９) and some full-width ASCII to half-width.
   */
  private normalizeFullWidth(text: string): string {
    return text.replace(/[０-９]/g, ch =>
      String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
    ).replace(/[Ａ-Ｚ]/g, ch =>
      String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
    );
  }

  /**
   * Filter out document header/footer lines that are not vehicle data.
   */
  private filterNonDataLines(lines: string[]): string[] {
    return lines.filter(line => {
      // Check against footer markers
      for (const marker of this.FOOTER_MARKERS) {
        if (line.includes(marker)) return false;
      }
      // Check against transport/summary markers
      for (const tKeyword of this.TRANSPORT_KEYWORDS) {
        if (line.includes(tKeyword)) return false;
      }
      // Filter summary lines that are pure formatted numbers like "38,766,920"
      if (/^[\d,]+$/.test(line) && line.includes(',')) return false;
      // Filter lines that are just page references like "12頁/" or "22頁/"
      if (/^\d+頁/.test(line)) return false;
      // Filter lines with dates in long format "2026 年 04 月 04 日"
      if (/\d{4}\s*年\s*\d{2}\s*月/.test(line)) return false;
      // Filter company address/registration lines
      if (/御中|株式会社ﾄﾖﾀ/.test(line) || /NAZLI/.test(line)) return false;
      // Keep everything else
      return true;
    });
  }

  /**
   * Group lines into blocks. A new block starts at an auction prefix
   * or a standalone venue name line.
   */
  private groupIntoBlocks(lines: string[]): string[][] {
    const blocks: string[][] = [];
    let currentBlock: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isNewBlock = this.isBlockStart(line, currentBlock);

      if (isNewBlock && currentBlock.length > 0) {
        blocks.push([...currentBlock]);
        currentBlock = [];
      }

      currentBlock.push(line);
    }

    // Push the last block
    if (currentBlock.length > 0) {
      blocks.push(currentBlock);
    }

    return blocks;
  }

  /**
   * Determine if a line represents the start of a new vehicle record block.
   */
  private isBlockStart(line: string, currentBlock: string[]): boolean {
    // 1. Auction platform prefix (TC-web, ANS, USS)
    for (const prefix of this.AUCTION_PREFIXES) {
      if (line.startsWith(prefix)) return true;
    }

    // 2. Standalone lot number (3-5 digits) — strongest leading indicator for second PDF format
    if (/^\d{3,5}$/.test(line.trim())) {
      // If we see a standalone 3-5 digit line, it's likely a new record starting.
      // We check if the current block already has significant data to justify a split.
      if (currentBlock.length >= 3) return true;
    }

    // 3. Standalone venue name (without leading digits — distinguishes "横浜" from "6横浜")
    if (this.isStandaloneVenue(line)) {
      return true;
    }

    // 4. Safety check: if current block already has a chassis and this line also has one
    if (currentBlock.length > 0) {
      const currentHasChassis = currentBlock.some(l => this.CHASSIS_INLINE_REGEX.test(l));
      
      // If we see another chassis, force a split
      if (currentHasChassis && this.CHASSIS_INLINE_REGEX.test(line)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a line is a standalone venue name (no leading digits).
   * "横浜" → true
   * "6横浜" → false (lot+area within a record)
   * "TC-webΣ" → false (handled by prefix check)
   */
  private isStandaloneVenue(line: string): boolean {
    // Must not start with a digit
    if (/^\d/.test(line)) return false;
    // Must be a known venue name (exact or startsWith)
    for (const venue of this.VENUE_NAMES) {
      if (line === venue || line.startsWith(venue + ' ')) return true;
    }
    return false;
  }

  /**
   * Validate blocks — each valid block must contain a chassis line.
   * Blocks without chassis are discarded or merged.
   */
  private validateBlocks(blocks: string[][]): string[][] {
    const valid: string[][] = [];

    for (const block of blocks) {
      if (block.length < 3) {
        this.logger.debug(`Discarding short block: ${JSON.stringify(block)}`);
        continue;
      }

      if (block.some(line => this.TRANSPORT_KEYWORDS.some(kw => line.includes(kw)))) {
        this.logger.debug(`Discarding transport/summary block: ${JSON.stringify(block)}`);
        continue;
      }

      const hasChassis = block.some(line => this.CHASSIS_INLINE_REGEX.test(line));

      if (hasChassis) {
        valid.push(block);
      } else {
        this.logger.debug(`Discarding block without chassis: ${JSON.stringify(block.slice(0, 2))}`);
      }
    }

    return valid;
  }
}
