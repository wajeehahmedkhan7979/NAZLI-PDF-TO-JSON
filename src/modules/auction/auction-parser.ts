import { Injectable, Logger } from '@nestjs/common';
import { BaseParser, RawParsedRow } from './parsers/base.parser';
import { USSParser } from './parsers/uss.parser';
import { TAAParser } from './parsers/taa.parser';
import { GenericParser } from './parsers/generic.parser';

export interface ParsedAuctionRow extends RawParsedRow {
  rawBlock: string[];
}

/**
 * AuctionParser — Dispatcher that selects the correct template parser.
 */
@Injectable()
export class AuctionParser {
  private readonly logger = new Logger(AuctionParser.name);
  private currentParser: BaseParser;

  constructor() {
    this.currentParser = new GenericParser();
  }

  /**
   * Detect the document format and select the appropriate parser.
   */
  selectParser(rawText: string): void {
    if (rawText.includes('USS')) {
      this.logger.log('Template Detected: USS');
      this.currentParser = new USSParser();
    } else if (rawText.includes('TAA')) {
      this.logger.log('Template Detected: TAA');
      this.currentParser = new TAAParser();
    } else {
      this.logger.warn('No specific template detected. Falling back to Generic Parser.');
      this.currentParser = new GenericParser();
    }
  }

  /**
   * Parse a single block using the selected template.
   */
  parseBlock(block: string[], documentYear: number): ParsedAuctionRow | null {
    const raw = this.currentParser.parse(block, documentYear);

    // ── Row Anchoring & Validation ──────────────────────────
    // IF NO CHASSIS IS FOUND OR CRITICAL PRICES ARE MISSING, REJECT.
    if (!raw.chassis || !raw.bid || !raw.total) {
      this.logger.warn(`Rejected invalid row: chassis=${raw.chassis}, bid=${raw.bid}, total=${raw.total}`);
      return null;
    }

    return {
      ...raw,
      rawBlock: block,
    };
  }
}
