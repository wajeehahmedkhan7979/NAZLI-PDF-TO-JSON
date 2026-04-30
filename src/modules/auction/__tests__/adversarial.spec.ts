import { Test, TestingModule } from '@nestjs/testing';
import { AuctionParser } from '../auction-parser';
import { BlockSegmenter } from '../block-segmenter';
import { NumericDecoder } from '../numeric-decoder';
import { AuctionValidator } from '../auction-validator';
import { ColumnMapper } from '../column-mapper';

describe('Adversarial Extraction Tests (Phase 8)', () => {
  let parser: AuctionParser;
  let segmenter: BlockSegmenter;
  let validator: AuctionValidator;
  let mapper: ColumnMapper;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuctionParser,
        BlockSegmenter,
        NumericDecoder,
        AuctionValidator,
        ColumnMapper,
      ],
    }).compile();

    parser = module.get<AuctionParser>(AuctionParser);
    segmenter = module.get<BlockSegmenter>(BlockSegmenter);
    validator = module.get<AuctionValidator>(AuctionValidator);
    mapper = module.get<ColumnMapper>(ColumnMapper);
  });

  describe('Adversarial Scenarios', () => {
    it('should fail safely on split chassis numbers', () => {
      const block = [
        'USS',
        'ﾌﾟﾘｳｽ',
        '04/04100000',
        '10000000100000',
        'KSP210-',    // Split chassis
        '0116561',
        '1000',
      ];
      
      const parsed = parser.parseBlock(block);
      const mapped = mapper.mapRow(parsed, 2026);
      const { valid, flags } = validator.validateRow(mapped);
      
      expect(valid).toBe(false);
      expect(flags).toContain('HARD_REJECT_NO_CHASSIS');
    });

    it('should handle repeated headers and not treat them as data', () => {
      const rawText = `
出品No
車名
年式
TC-web
ﾔﾘｽ
04/041000000
1550
15500094501849000
184900
KSP210-0116561
6兵庫
2211306*
      `;
      
      const blocks = segmenter.segment(rawText);
      expect(blocks.length).toBe(1); // Should only extract the actual vehicle, not headers
      expect(blocks[0]).toContain('KSP210-0116561');
    });

    it('should fail safely on missing columns (missing bid/total)', () => {
      const block = [
        'TC-web',
        'ﾔﾘｽ',
        '04/04', // Missing bid
        '1550',
        // Missing packed line
        'KSP210-0116561',
        '6兵庫'
      ];
      
      const parsed = parser.parseBlock(block);
      const mapped = mapper.mapRow(parsed, 2026);
      const { valid, flags } = validator.validateRow(mapped);
      
      expect(valid).toBe(false);
      expect(flags).toContain('HARD_REJECT_NO_PRICE');
      expect(flags).toContain('MISSING_FINAL_PRICE');
    });

    it('should handle multi-page purchase tables by segmenting correctly', () => {
      const rawText = `
TC-web
ﾔﾘｽ
04/041000000
1550
15500094501849000
184900
KSP210-0116561
6兵庫

12頁/
オークション計算書
横浜

TC-web
ｶﾛｰﾗ
04/04500000
1550
1550009450500000
50000
NKE165-7242861
7兵庫
      `;
      
      const blocks = segmenter.segment(rawText);
      expect(blocks.length).toBe(2);
      expect(blocks[0]).toContain('KSP210-0116561');
      expect(blocks[1]).toContain('NKE165-7242861');
    });

    it('should handle skewed scans by relying on robust regex over strict order', () => {
      // Order of lines messed up slightly due to skewed scan OCR
      const block = [
        '184900', // Total divisor came early
        '1550',   // Fee came early
        'TC-web',
        'ﾔﾘｽ',
        '04/041838000', // 1838000 + 1550 + 9450 = 1849000
        'KSP210-0116561',
        '15500094501849000',
        '6兵庫'
      ];
      
      const parsed = parser.parseBlock(block);
      const mapped = mapper.mapRow(parsed, 2026);
      const { valid, flags } = validator.validateRow(mapped);
      
      // Because we use robust regex/digit patterns (Phase 3/4), it should still parse successfully
      expect(valid).toBe(true);
      expect(mapped.chassis).toBe('KSP210-0116561');
      expect(mapped.finalPrice).toBe(1849000); // Decoded from packed line
      expect(flags.length).toBe(0);
    });
  });
});
