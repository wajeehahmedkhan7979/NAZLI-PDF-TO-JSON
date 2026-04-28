import { Injectable, Logger } from '@nestjs/common';
import { NumericDecoder, NumericDecodeResult } from './numeric-decoder';

/**
 * Parsed fields from a single block, before column mapping.
 */
export interface ParsedAuctionRow {
  auctionPlatform: string | null; // "TC-web", "ANS", etc.
  auctionSuffix: string | null;   // "Σ", "ﾘｱﾙ", "不在"
  carName: string | null;         // Japanese car name
  date: string | null;            // "04/04"
  startingPrice: number | null;   // Base price from header line
  auctionFee: number | null;      // Standalone fee line
  recycle: number | null;
  jidosha: number | null;
  finalPrice: number | null;      // Actual winning bid (from packed line)
  chassis: string | null;         // "KSP210-0116561"
  lotNumber: number | null;       // Leading digits from location line
  auctionLocation: string | null; // Japanese area from location line
  exhibitRef: string | null;      // Exhibit reference number
  confidence: number;
  flags: string[];
  rawBlock: string[];
}

/**
 * Auction Parser — Extracts structured fields from segmented blocks.
 *
 * Each block follows a fixed line pattern:
 *   Line 0: [AUCTION_PREFIX] or [VENUE]
 *   Line 1: [CAR_NAME]
 *   Line 2: [DATE][BID]
 *   Line 3: [AUCTION_FEE]
 *   Line 4: [PACKED_NUMBERS]
 *   Line 5: [SUBTOTAL/10]
 *   Line 6: [CHASSIS] (possibly with leading number)
 *   Line 7: [LOT+AREA]
 *   Line 8: [EXHIBIT_REF] (possibly with jidosha suffix)
 *
 * Uses positional hints + regex patterns rather than fixed indices.
 */
@Injectable()
export class AuctionParser {
  private readonly logger = new Logger(AuctionParser.name);

  private readonly AUCTION_PREFIXES = ['TC-web', 'ANS', 'USS'];
  private readonly CHASSIS_REGEX = /([A-Z][A-Z0-9]*-\d{4,})/;
  private readonly DATE_REGEX = /(\d{2}\/\d{2})/;
  // We'll no longer use LOT_AREA_REGEX for Lot number, only for Area if it's packed.
  private readonly AREA_REGEX = /^(\d+)?([^\d].+)$/;
  private readonly VENUE_NAMES = [
    '横浜', '兵庫', '東京', '名古屋', '大阪', '福岡', '札幌',
    '仙台', '広島', '北海道', '静岡', '新潟', '岡山', '群馬',
    '東北', '関東', '中部', '関西', '九州', 'Tohoku', 'Tokyo', 'Kanto', 'Kansai',
    'Hiroshima', 'Kyushu', 'Chūbu', 'Chubu', 'Shikoku', '四国'
  ];

  // Specific common auction fee values that are often confused with Lot Numbers in some PDF layouts
  private readonly COMMON_FEES = [1300, 1450, 1550, 1650, 1750, 1850, 1900, 3100, 4900];

  constructor(private numericDecoder: NumericDecoder) {}

  /**
   * Parse a single block of lines into a structured row.
   */
  parseBlock(block: string[]): ParsedAuctionRow {
    const flags: string[] = [];
    let confidence = 1.0;

    // ── Identify line roles by content pattern ──────────────────
    const roles = this.identifyLineRoles(block);

    // ── Extract auction prefix ─────────────────────────────────
    const { platform: auctionPlatformRaw, venue: prefixVenue, suffix: auctionSuffix, carNameFromPrefix } = this.parseAuctionPrefix(
      roles.prefixLine,
    );

    // ── Extract car name ───────────────────────────────────────
    let carName = roles.carNameLine || carNameFromPrefix || null;

    // ── Extract date + startingPrice ───────────────────────────
    let date: string | null = null;
    let startingPrice: number | null = null;
    if (roles.dateBidLine) {
      const dateMatch = roles.dateBidLine.match(this.DATE_REGEX);
      if (dateMatch) {
        date = dateMatch[1];
        // Starting Price is the number after the date
        const afterDate = roles.dateBidLine.substring(dateMatch.index! + dateMatch[0].length);
        const bidDigits = afterDate.replace(/[^\d]/g, '');
        if (bidDigits.length > 0) {
          startingPrice = parseInt(bidDigits, 10);
        }
      }
    }

    // ── Extract auction fee ────────────────────────────────────
    let auctionFee: number | null = null;
    if (roles.feeLine) {
      const feeDigits = roles.feeLine.replace(/[^\d]/g, '');
      if (feeDigits.length > 0 && feeDigits.length <= 6) {
        auctionFee = parseInt(feeDigits, 10);
      }
    }

    // ── Decode packed or standalone numeric prices ───────────────
    let numericResult = this.numericDecoder.decode(
      roles.packedLine || '',
      auctionFee,
      roles.subtotalLine,
    );
    if (numericResult.flags.length > 0) {
      flags.push(...numericResult.flags);
    }

    // ── Extract chassis ────────────────────────────────────────
    let chassis: string | null = null;
    if (roles.chassisLine) {
      const chassisMatch = roles.chassisLine.match(this.CHASSIS_REGEX);
      if (chassisMatch) {
        chassis = chassisMatch[1];
      }
    }

    if (!chassis) {
      flags.push('CHASSIS_NOT_FOUND');
      confidence *= 0.3;
    }

    // ── Extract lot + area ─────────────────────────────────────
    let lotNumber: number | null = null;
    let auctionLocation: string | null = prefixVenue; // default to prefix venue if found
    
    // Attempt to extract true lot number (standalone 3-5 digits usually)
    if (roles.lotLine) {
      lotNumber = parseInt(roles.lotLine.trim(), 10);
    }
    
    if (roles.lotAreaLine) {
      const areaMatch = roles.lotAreaLine.match(this.AREA_REGEX);
      if (areaMatch) {
         auctionLocation = areaMatch[2].trim();
      }
    }

    // ── Extract exhibit ref and check for jidosha suffix ───────
    let exhibitRef: string | null = roles.exhibitLine || null;
    // Some exhibit lines end with a number after * (jidosha tax)
    if (exhibitRef) {
      const jidoshaFromExhibit = exhibitRef.match(/\*(\d+)$/);
      if (jidoshaFromExhibit && numericResult.jidosha === null) {
        // Cross-check: exhibit suffix might be jidosha
        const possibleJidosha = parseInt(jidoshaFromExhibit[1], 10);
        if (possibleJidosha > 0) {
          numericResult.jidosha = possibleJidosha;
        }
      }
    }

    // ── Aggregate confidence ───────────────────────────────────
    confidence *= numericResult.confidence > 0 ? numericResult.confidence : 0.5;

    return {
      auctionPlatform: auctionPlatformRaw || 'UNKNOWN',
      auctionSuffix,
      carName,
      date,
      startingPrice: startingPrice && numericResult.total && startingPrice > numericResult.total ? numericResult.total : startingPrice,
      auctionFee,
      recycle: numericResult.recycle,
      jidosha: numericResult.jidosha,
      finalPrice: startingPrice && numericResult.total && startingPrice > numericResult.total ? startingPrice : numericResult.total,
      chassis,
      lotNumber,
      auctionLocation,
      exhibitRef,
      confidence: parseFloat(confidence.toFixed(3)),
      flags,
      rawBlock: block,
    };
  }

  /**
   * Identify the role of each line within a block using content patterns.
   * This is more robust than fixed indices — handles blocks of varying length.
   */
  private identifyLineRoles(block: string[]): {
    prefixLine: string | null;
    carNameLine: string | null;
    dateBidLine: string | null;
    feeLine: string | null;
    packedLine: string | null;
    subtotalLine: string | null;
    chassisLine: string | null;
    lotAreaLine: string | null;
    exhibitLine: string | null;
    lotLine: string | null;
  } {
    let prefixLine: string | null = null;
    let carNameLine: string | null = null;
    let dateBidLine: string | null = null;
    let feeLine: string | null = null;
    let packedLine: string | null = null;
    let subtotalLine: string | null = null;
    let chassisLine: string | null = null;
    let lotAreaLine: string | null = null;
    let exhibitLine: string | null = null;
    let lotLine: string | null = null;

    const used = new Set<number>();

    // Pass 1: Find high-confidence matches first
    for (let i = 0; i < block.length; i++) {
      const line = block[i];

      // Chassis line (very distinctive pattern)
      if (!chassisLine && this.CHASSIS_REGEX.test(line)) {
        chassisLine = line;
        used.add(i);
        continue;
      }

      // Date line (contains MM/DD pattern)
      if (!dateBidLine && this.DATE_REGEX.test(line)) {
        // We'll no longer require 4+ digits on the same line to identify it as a date block,
        // as the bid price might have shifted to the next line in PDF 2.
        dateBidLine = line;
        used.add(i);
        continue;
      }

      // Lot+Area line (digit(s) followed by Japanese chars, or just venue)
      if (!lotAreaLine && this.AREA_REGEX.test(line) && line.length <= 10) {
        // Must contain a known venue name
        const hasVenue = this.VENUE_NAMES.some(v => line.includes(v));
        if (hasVenue) {
          lotAreaLine = line;
          used.add(i);
          continue;
        }
      }

      // True Lot Number line: 3-5 standalone digits (often directly preceding Chassis or at start)
      if (!lotLine && /^\d{3,6}$/.test(line.trim())) {
        const val = parseInt(line.trim(), 10);
        // HEURISTIC: Skip if it's a common auction fee AND it's not the very first line of the block
        // (This helps distinguish Lot 1450 from Fee 1450 if they both match the regex)
        const isCommonFee = this.COMMON_FEES.includes(val);
        const isLateInBlock = i > 2;

        if (isCommonFee && isLateInBlock) {
          // Likely a fee masquerading as a lot, skip for now to let Pass 3 catch it as a fee
          this.logger.debug(`Skipping lot candidate ${val} at index ${i} - likely a fee`);
        } else {
          lotLine = line.trim();
          used.add(i);
          continue;
        }
      }

      // Exhibit reference (ends with digits + * or digits + *digits)
      if (!exhibitLine && /\d+\*/.test(line) && !this.DATE_REGEX.test(line)) {
        exhibitLine = line;
        used.add(i);
        continue;
      }
    }

    // Pass 2: Identify prefix and car name (usually first 1-2 lines)
    for (let i = 0; i < Math.min(3, block.length); i++) {
      if (used.has(i)) continue;
      const line = block[i];

      // Auction prefix
      if (!prefixLine) {
        const isPrefix = this.AUCTION_PREFIXES.some(p => line.startsWith(p));
        const isVenue = this.VENUE_NAMES.some(v => line === v);
        if (isPrefix || isVenue) {
          prefixLine = line;
          used.add(i);
          continue;
        }
      }

      // Car name (Contains Japanese or alphabetic characters, not pure digits/chassis)
      if (!carNameLine && /[a-zA-Z\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf]/.test(line) && !/^\d/.test(line)) {
        // Ensure it's not a known prefix/venue line already picked up
        if (line !== prefixLine && line !== lotAreaLine) {
          carNameLine = line;
          used.add(i);
        }
      }
    }

    // Pass 3: Fee and packed lines (numeric lines between date and chassis)
    const numericLines: { idx: number; line: string; digitCount: number }[] = [];
    for (let i = 0; i < block.length; i++) {
      if (used.has(i)) continue;
      const line = block[i];
      const digitsOnly = line.replace(/[^\d]/g, '');
      if (digitsOnly.length > 0 && digitsOnly.length === line.length) {
        numericLines.push({ idx: i, line, digitCount: digitsOnly.length });
      }
    }

    // Sort numeric lines: short ones are fee, long ones are packed
    numericLines.sort((a, b) => a.digitCount - b.digitCount);

    for (const nl of numericLines) {
      if (!feeLine && nl.digitCount >= 3 && nl.digitCount <= 5) {
        feeLine = nl.line;
        used.add(nl.idx);
      } else if (!packedLine && nl.digitCount >= 10) {
        packedLine = nl.line;
        used.add(nl.idx);
      } else if (!subtotalLine && nl.digitCount >= 6 && nl.digitCount <= 9) {
        // Shorter total/bid lines found in second PDF format
        subtotalLine = nl.line;
        used.add(nl.idx);
      }
    }

    // If subtotal not found yet, look for numeric line right after packed
    if (!subtotalLine && packedLine) {
      const packedIdx = block.indexOf(packedLine);
      if (packedIdx >= 0 && packedIdx + 1 < block.length) {
        const nextLine = block[packedIdx + 1];
        if (!used.has(packedIdx + 1) && /^\d+$/.test(nextLine)) {
          subtotalLine = nextLine;
        }
      }
    }

    // If no true lot line, we keep lotNumber null so logic doesn't wrongly take it from class rating!
    
    return {
      prefixLine,
      carNameLine,
      dateBidLine,
      feeLine,
      packedLine,
      subtotalLine,
      chassisLine,
      lotAreaLine,
      exhibitLine,
      lotLine,
    };
  }

  /**
   * Parse the auction prefix line into auction source + suffix + possible car name.
   */
  private parseAuctionPrefix(line: string | null): {
    platform: string | null;
    venue: string | null;
    suffix: string | null;
    carNameFromPrefix: string | null;
  } {
    if (!line) return { platform: null, venue: null, suffix: null, carNameFromPrefix: null };

    for (const prefix of this.AUCTION_PREFIXES) {
      if (line.startsWith(prefix)) {
        const rest = line.substring(prefix.length);
        // Suffix like Σ, ﾘｱﾙ, 不在
        let suffix: string | null = null;
        let carNameFromPrefix: string | null = null;

        if (rest.startsWith('Σ')) {
          suffix = 'Σ';
          carNameFromPrefix = rest.substring(1).trim() || null;
        } else if (rest.startsWith('ﾘｱﾙ')) {
          suffix = 'ﾘｱﾙ';
          carNameFromPrefix = rest.substring(3).trim() || null;
        } else if (rest.startsWith('不在')) {
          suffix = '不在';
          carNameFromPrefix = rest.substring(2).trim() || null;
        } else {
          carNameFromPrefix = rest.trim() || null;
        }

        return { platform: prefix, venue: null, suffix, carNameFromPrefix };
      }
    }

    // Line is a standalone venue name — used as auctionLocation
    return { platform: null, venue: line, suffix: null, carNameFromPrefix: null };
  }
}
