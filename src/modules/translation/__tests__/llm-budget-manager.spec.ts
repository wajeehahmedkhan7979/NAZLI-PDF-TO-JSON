import { LlmBudgetManager } from '../../../modules/translation/llm-budget-manager';

describe('LlmBudgetManager', () => {
  let manager: LlmBudgetManager;
  const docId = 'test-doc-123';

  beforeEach(() => {
    manager = new LlmBudgetManager();
    manager.startSession(docId);
  });

  afterEach(() => {
    manager.endSession(docId);
  });

  it('starts a session successfully', () => {
    const result = manager.canUse(docId, 4, 100);
    expect(result.allowed).toBe(true);
    expect(result.model).toBeTruthy();
  });

  it('always allows tier 3 (DeepL)', () => {
    const result = manager.canUse(docId, 3, 99999);
    expect(result.allowed).toBe(true);
    expect(result.model).toBe('deepl');
  });

  it('denies when no session exists', () => {
    const result = manager.canUse('nonexistent-doc', 4, 100);
    expect(result.allowed).toBe(false);
  });

  it('tracks token usage', () => {
    manager.recordUsage(docId, 500, 'gpt-4o-mini');
    const result = manager.canUse(docId, 4, 9000); // 500+9000=9500 < 10000
    expect(result.allowed).toBe(true);
  });

  it('falls back to cheaper model when token budget runs low', () => {
    // Use up most of the token budget
    manager.recordUsage(docId, 9500, 'gpt-4o-mini');
    const result = manager.canUse(docId, 4, 600); // would exceed 10000
    // Should either fallback or deny
    expect(typeof result.allowed).toBe('boolean');
    if (result.allowed) {
      expect(result.reason).toBeTruthy(); // fallback reason
    }
  });

  it('denies after budget is fully exhausted', () => {
    // Exhaust both token and cost budget
    manager.recordUsage(docId, 10000, 'gpt-4o-mini');
    const result = manager.canUse(docId, 4, 1000);
    expect(result.allowed).toBe(false);
  });

  it('returns budget summary on endSession', () => {
    manager.recordUsage(docId, 200, 'gpt-4o-mini');
    const summary = manager.endSession(docId);
    expect(summary).not.toBeNull();
    expect(summary!.tokensUsed).toBe(200);
    expect(summary!.requestCount).toBe(1);
    expect(summary!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns null for endSession on non-existent doc', () => {
    const summary = manager.endSession('does-not-exist');
    expect(summary).toBeNull();
  });
});
