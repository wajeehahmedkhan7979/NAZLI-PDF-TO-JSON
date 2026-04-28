import { AuctionSheetProcessor } from './src/modules/auction/auction-sheet.processor';
import { BlockSegmenter } from './src/modules/auction/block-segmenter';
import { AuctionParser } from './src/modules/auction/auction-parser';
import { ColumnMapper } from './src/modules/auction/column-mapper';
import { AuctionValidator } from './src/modules/auction/auction-validator';
import { NumericDecoder } from './src/modules/auction/numeric-decoder';
import * as fs from 'fs';

async function dump() {
    const segmenter = new BlockSegmenter();
    const decoder = new NumericDecoder();
    const parser = new AuctionParser(decoder);
    
    // Read raw text from the knowledge item if available, or simulate a small block from user's report
    const sampleBlock = [
        "1550",           // This is being caught as Lot
        "RAIZE Z",
        "A202A-0147410",
        "九州",
        "03/31",
        "1692000",        // Subtotal
        "9000226640"      // Actually packed?
    ];
    
    const parsed = parser.parseBlock(sampleBlock);
    console.log("PARSED ROLES:");
    console.log(JSON.stringify(parsed, null, 2));
}
dump();
