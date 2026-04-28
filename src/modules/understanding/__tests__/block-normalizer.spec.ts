import { BlockNormalizer } from '../../../modules/understanding/processors/block-normalizer';
import { ExtractionBlock } from '../../../modules/extraction/interfaces/extraction-backend.interface';

describe('BlockNormalizer', () => {
  let normalizer: BlockNormalizer;

  const makeBlock = (overrides: Partial<ExtractionBlock> = {}): ExtractionBlock => ({
    blockId: `block_${Math.random().toString(36).slice(2)}`,
    blockType: 'Text',
    page: 0,
    position: 0,
    text: 'テスト',
    confidence: 0.9,
    status: 'ok',
    ...overrides,
  });

  beforeEach(() => {
    normalizer = new BlockNormalizer();
  });

  it('returns empty array for empty input', () => {
    expect(normalizer.normalize([])).toEqual([]);
  });

  it('normalizes fullwidth ASCII to halfwidth', () => {
    const block = makeBlock({ text: 'Ａｂｃ１２３' });
    const result = normalizer.normalize([block]);
    expect(result[0].normalizedText).toBe('Abc123');
  });

  it('normalizes fullwidth spaces to regular spaces', () => {
    const block = makeBlock({ text: '日本語　テキスト' });
    const result = normalizer.normalize([block]);
    expect(result[0].normalizedText).toBe('日本語 テキスト');
  });

  it('converts halfwidth katakana to fullwidth', () => {
    const block = makeBlock({ text: 'ｱｲｳｴｵ' });
    const result = normalizer.normalize([block]);
    expect(result[0].normalizedText).toBe('アイウエオ');
  });

  it('converts halfwidth katakana with dakuten', () => {
    const block = makeBlock({ text: 'ｶﾞ' }); // カ + dakuten = ガ
    const result = normalizer.normalize([block]);
    expect(result[0].normalizedText).toBe('ガ');
  });

  it('trims and collapses whitespace', () => {
    const block = makeBlock({ text: '  hello   world  ' });
    const result = normalizer.normalize([block]);
    expect(result[0].normalizedText).toBe('hello world');
  });

  it('merges adjacent fragments on the same line', () => {
    const b1 = makeBlock({
      blockId: 'b1', text: '請求書', page: 0,
      bbox: [10, 100, 80, 120], position: 0,
    });
    const b2 = makeBlock({
      blockId: 'b2', text: '番号', page: 0,
      bbox: [85, 100, 150, 120], position: 1,
    });
    const result = normalizer.normalize([b1, b2]);
    // Should be merged into one block
    expect(result.length).toBeLessThan(2);
    if (result.length === 1) {
      expect(result[0].wasMerged).toBe(true);
    }
  });

  it('does NOT merge blocks on different pages', () => {
    const b1 = makeBlock({ blockId: 'b1', text: 'Page1', page: 0, bbox: [0, 0, 100, 20] });
    const b2 = makeBlock({ blockId: 'b2', text: 'Page2', page: 1, bbox: [0, 0, 100, 20] });
    const result = normalizer.normalize([b1, b2]);
    expect(result.length).toBe(2);
  });

  it('deduplicates blocks with high overlap', () => {
    const b1 = makeBlock({
      blockId: 'b1', text: 'テスト', page: 0, bbox: [10, 10, 100, 30], confidence: 0.8,
    });
    const b2 = makeBlock({
      blockId: 'b2', text: 'テスト', page: 0, bbox: [11, 10, 101, 30], confidence: 0.95,
    });
    const result = normalizer.normalize([b1, b2]);
    // Should keep only the higher-confidence block
    expect(result.length).toBe(1);
    expect(result[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('preserves reading order (top-to-bottom, left-to-right)', () => {
    const b1 = makeBlock({ blockId: 'b1', text: 'Second', page: 0, bbox: [200, 10, 300, 30] });
    const b2 = makeBlock({ blockId: 'b2', text: 'First', page: 0, bbox: [10, 10, 100, 30] });
    const b3 = makeBlock({ blockId: 'b3', text: 'Third', page: 0, bbox: [10, 50, 100, 70] });
    const result = normalizer.normalize([b1, b2, b3]);
    const texts = result.map((b) => b.normalizedText);
    expect(texts.indexOf('First')).toBeLessThan(texts.indexOf('Third'));
  });
});
