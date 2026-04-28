import { SegmentationService } from '../../../modules/segmentation/segmentation.service';
import { UnderstoodBlock } from '../../../modules/understanding/interfaces/understanding.interfaces';
import { FieldCandidate } from '../../../modules/understanding/interfaces/understanding.interfaces';

describe('SegmentationService', () => {
  let service: SegmentationService;

  const makeBlock = (overrides: Partial<UnderstoodBlock> = {}): UnderstoodBlock => ({
    blockId: `b_${Math.random().toString(36).slice(2)}`,
    blockType: 'Text',
    page: 0,
    position: 0,
    text: 'テスト',
    normalizedText: 'テスト',
    confidence: 0.9,
    status: 'ok',
    sectionType: 'UNKNOWN',
    sectionConfidence: 0,
    wasMerged: false,
    ...overrides,
  });

  const makeCandidate = (overrides: Partial<FieldCandidate> = {}): FieldCandidate => ({
    fieldType: 'INVOICE_NUMBER',
    value: 'INV-001',
    sourceBlockId: 'b1',
    page: 0,
    confidence: 0.9,
    context: { section: 'HEADER', nearbyLabels: [] },
    ...overrides,
  });

  beforeEach(() => {
    service = new SegmentationService();
  });

  it('returns a single group for a 1-page document', () => {
    const blocks = [makeBlock({ page: 0, normalizedText: '請求書' })];
    const result = service.segment(blocks, [], 1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].pageRange).toEqual({ start: 0, end: 0 });
  });

  it('keeps continuous document as one group', () => {
    // Same invoice number across all pages
    const blocks = [
      makeBlock({ page: 0, normalizedText: '請求書', sectionType: 'HEADER' }),
      makeBlock({ page: 1, normalizedText: '明細', sectionType: 'LINE_ITEMS' }),
      makeBlock({ page: 2, normalizedText: '合計', sectionType: 'TOTALS' }),
    ];
    const candidates = [
      makeCandidate({ page: 0, fieldType: 'INVOICE_NUMBER', value: 'INV-001' }),
      makeCandidate({ page: 1, fieldType: 'INVOICE_NUMBER', value: 'INV-001' }),
      makeCandidate({ page: 2, fieldType: 'INVOICE_NUMBER', value: 'INV-001' }),
    ];
    const result = service.segment(blocks, candidates, 3);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].pageRange.end).toBe(2);
  });

  it('splits on invoice number change (hard rule)', () => {
    const blocks = [
      makeBlock({ page: 0, normalizedText: '請求書', sectionType: 'HEADER' }),
      makeBlock({ page: 1, normalizedText: '請求書', sectionType: 'HEADER' }),
    ];
    const candidates = [
      makeCandidate({ page: 0, fieldType: 'INVOICE_NUMBER', value: 'INV-001' }),
      makeCandidate({ page: 1, fieldType: 'INVOICE_NUMBER', value: 'INV-002' }),
    ];
    const result = service.segment(blocks, candidates, 2);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].pageRange.end).toBe(0);
    expect(result.groups[1].pageRange.start).toBe(1);
  });

  it('stores segmentation signals in group metadata', () => {
    const blocks = [
      makeBlock({ page: 0, normalizedText: '請求書INV-001', sectionType: 'HEADER' }),
      makeBlock({ page: 1, normalizedText: '請求書INV-002', sectionType: 'HEADER' }),
    ];
    const candidates = [
      makeCandidate({ page: 0, value: 'INV-001' }),
      makeCandidate({ page: 1, value: 'INV-002' }),
    ];
    const result = service.segment(blocks, candidates, 2);
    expect(result.groups.length).toBeGreaterThanOrEqual(1);
    result.groups.forEach((g) => {
      expect(Array.isArray(g.signals)).toBe(true);
    });
  });

  it('detects AUCTION_SHEET group type', () => {
    const blocks = [
      makeBlock({ page: 0, normalizedText: 'TC-web オークション計算書', sectionType: 'HEADER' }),
    ];
    const result = service.segment(blocks, [], 1);
    expect(result.groups[0].groupType).toBe('AUCTION_SHEET');
  });

  it('includes page range in each group', () => {
    const blocks = Array.from({ length: 4 }, (_, i) =>
      makeBlock({ page: i, normalizedText: `Page ${i}` }),
    );
    const result = service.segment(blocks, [], 4);
    for (const g of result.groups) {
      expect(g.pageRange.start).toBeLessThanOrEqual(g.pageRange.end);
      expect(g.pageRange.end).toBeLessThan(4);
    }
  });

  it('reports correct totalPages and elapsedMs', () => {
    const blocks = [makeBlock({ page: 0 }), makeBlock({ page: 1 })];
    const result = service.segment(blocks, [], 2);
    expect(result.totalPages).toBe(2);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
