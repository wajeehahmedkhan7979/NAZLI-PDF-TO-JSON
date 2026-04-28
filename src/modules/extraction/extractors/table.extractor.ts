import { Injectable, Logger } from '@nestjs/common';
import { ExtractionResultBlock } from './pdf-text.extractor';

@Injectable()
export class TableExtractor {
  private readonly logger = new Logger(TableExtractor.name);

  // Fallback programmatic table extraction based on spatial grouping of text bounds
  // Takes raw blocks and heuristically joins them into table rows
  extractTablesFromBlocks(blocks: ExtractionResultBlock[]): ExtractionResultBlock[] {
    this.logger.debug(`Detecting tables from ${blocks.length} blocks`);
    
    // In a real system, you'd sort by Y, then X, and group if Y is within delta (e.g. 5px)
    // We mark candidates for later schema mapping
    
    return blocks.map(block => {
      // Very naive heuristic: if block contains numbers, units, and symbols, it might be a line item row
      const isLikelyTableRow = /\d+/.test(block.text) && (block.text.includes('円') || block.text.includes('JPY') || block.text.includes('個'));
      
      if (isLikelyTableRow) {
        return { ...block, type: 'table_row' };
      }
      return block;
    });
  }
}
