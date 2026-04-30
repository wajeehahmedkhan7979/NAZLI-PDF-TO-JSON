import { Module } from '@nestjs/common';
import { BlockSegmenter } from './block-segmenter';
import { NumericDecoder } from './numeric-decoder';
import { AuctionParser } from './auction-parser';
import { ColumnMapper } from './column-mapper';
import { AuctionValidator } from './auction-validator';
import { AuctionSheetProcessor } from './auction-sheet.processor';
import { AuctionOcr } from './auction-ocr';

@Module({
  providers: [
    BlockSegmenter,
    NumericDecoder,
    AuctionParser,
    ColumnMapper,
    AuctionValidator,
    AuctionOcr,
    AuctionSheetProcessor,
  ],
  exports: [AuctionSheetProcessor],
})
export class AuctionModule {}
