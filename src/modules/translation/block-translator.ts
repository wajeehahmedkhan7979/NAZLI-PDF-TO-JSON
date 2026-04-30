import { Injectable, Logger } from '@nestjs/common';
import { UnderstoodBlock } from '../understanding/interfaces/understanding.interfaces';
import { IdentifierShield, ShieldedText } from './identifier-shield';
import { GlossaryService } from './deterministic/glossary.service';
import { AiTranslationService } from './ai-fallback/ai-translation.service';
import { LlmBudgetManager } from './llm-budget-manager';

/**
 * TranslationContext — passed with each batch to provide context-awareness.
 * Without context, ambiguous terms like "合計" or "金額" can be mistranslated.
 */
export interface TranslationContext {
  /** Document type (PURCHASE, BILLING, AUCTION_SHEET, etc.) */
  documentType: string;
  /** Current section being translated */
  section: string;
  /** Text from previous blocks for continuity */
  previousBlocks: string[];
  /** Glossary hints relevant to this context */
  glossaryHints: string[];
  /** Tenant ID for tenant-specific glossary */
  tenantId?: string;
}

export interface TranslatedBlock {
  /** Source block ID */
  blockId: string;
  /** Original Japanese text */
  originalText: string;
  /** Translated English text */
  translatedText: string;
  /** Translation confidence */
  confidence: number;
  /** Which tier was used */
  tier: 1 | 2 | 3 | 4;
  /** Translation method description */
  method: string;
  /** Identifiers that were preserved (not translated) */
  preservedIdentifiers: string[];
  /** Processing status */
  status: 'ok' | 'partial' | 'failed';
  /** Error if failed */
  error?: string;
}

/**
 * BlockTranslator — tiered, batched, context-aware translation.
 *
 * Tiers:
 *   1. Glossary (deterministic, free)
 *   2. Rule-based (numbers, dates, formats — free)
 *   3. DeepL/Google (high accuracy, low cost)
 *   4. GPT fallback (context-dependent, budget-controlled)
 *
 * Features:
 * - Batched translation for efficiency
 * - Context-aware: passes document type, section, and glossary hints
 * - Identifier shielding: VINs, dates, amounts are never translated
 * - LLM budget control: GPT usage is metered and capped
 */
@Injectable()
export class BlockTranslator {
  private readonly logger = new Logger(BlockTranslator.name);

  /** Simple translation cache: text → translated */
  private cache = new Map<string, { translated: string; confidence: number; tier: number }>();

  constructor(
    private identifierShield: IdentifierShield,
    private glossaryService: GlossaryService,
    private aiTranslation: AiTranslationService,
    private budgetManager: LlmBudgetManager,
  ) {}

  /**
   * Translate a batch of understood blocks with context.
   */
  async translateBatch(
    blocks: UnderstoodBlock[],
    context: TranslationContext,
    documentId: string,
  ): Promise<TranslatedBlock[]> {
    this.logger.log(
      `Translating batch: ${blocks.length} blocks, type=${context.documentType}, section=${context.section}`,
    );

    // Start LLM budget session
    this.budgetManager.startSession(documentId);

    const results: TranslatedBlock[] = [];

    for (const block of blocks) {
      try {
        const translated = await this.translateBlock(block, context, documentId);
        results.push(translated);
      } catch (err: any) {
        // Block-level resilience: mark as failed, continue
        this.logger.error(`Translation failed for block ${block.blockId}: ${err.message}`);
        results.push({
          blockId: block.blockId,
          originalText: block.normalizedText,
          translatedText: block.normalizedText, // Keep original on failure
          confidence: 0,
          tier: 1,
          method: 'failed',
          preservedIdentifiers: [],
          status: 'failed',
          error: err.message,
        });
      }
    }

    // End budget session
    const budgetSummary = this.budgetManager.endSession(documentId);
    if (budgetSummary) {
      this.logger.log(
        `Translation complete: ${results.length} blocks, ` +
          `${budgetSummary.tokensUsed} LLM tokens used, $${budgetSummary.costUsed.toFixed(4)}`,
      );
    }

    return results;
  }

  /**
   * Translate a single block through the tier waterfall.
   */
  private async translateBlock(
    block: UnderstoodBlock,
    context: TranslationContext,
    documentId: string,
  ): Promise<TranslatedBlock> {
    const text = block.normalizedText;

    // Skip empty blocks
    if (!text || text.trim().length === 0) {
      return {
        blockId: block.blockId,
        originalText: text,
        translatedText: '',
        confidence: 1.0,
        tier: 1,
        method: 'empty',
        preservedIdentifiers: [],
        status: 'ok',
      };
    }

    // Skip blocks that are purely identifiers/numbers (no Japanese)
    if (!this.containsJapanese(text)) {
      return {
        blockId: block.blockId,
        originalText: text,
        translatedText: text,
        confidence: 1.0,
        tier: 2,
        method: 'no_japanese',
        preservedIdentifiers: [],
        status: 'ok',
      };
    }

    // ── Step 5: Translation Boundary Enforcement ───────────
    // Strict bypass for numeric/identifier blocks to prevent LLM hallucination
    const numericRatio = this.calculateNumericRatio(text);
    const containsCurrency = /[¥￥円]/.test(text) || /\b(JPY|USD)\b/i.test(text);
    const containsChassisPattern = /[A-Z0-9]+-\d{4,}/.test(text);

    if (numericRatio > 0.4 || containsCurrency || containsChassisPattern) {
      return {
        blockId: block.blockId,
        originalText: text,
        translatedText: text, // Skip translation
        confidence: 1.0,
        tier: 2,
        method: 'strict_boundary_pass',
        preservedIdentifiers: [],
        status: 'ok',
      };
    }

    // Check cache
    const cacheKey = this.cacheKey(text, context);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return {
        blockId: block.blockId,
        originalText: text,
        translatedText: cached.translated,
        confidence: cached.confidence,
        tier: cached.tier as 1 | 2 | 3 | 4,
        method: 'cache',
        preservedIdentifiers: [],
        status: 'ok',
      };
    }

    // Shield identifiers before translation
    const shielded = this.identifierShield.shield(text);
    const preservedIdentifiers = shielded.identifiedItems.map((i) => i.original);

    // ── Tier 1: Glossary (deterministic) ─────────────────────
    const glossaryResult = await this.tryGlossary(shielded.shieldedText, context.tenantId);
    if (glossaryResult && glossaryResult.confidence >= 0.8) {
      const translated = this.identifierShield.unshield(glossaryResult.english, shielded.tokens);
      this.cacheResult(cacheKey, translated, glossaryResult.confidence, 1);
      return {
        blockId: block.blockId,
        originalText: text,
        translatedText: translated,
        confidence: glossaryResult.confidence,
        tier: 1,
        method: 'glossary',
        preservedIdentifiers,
        status: 'ok',
      };
    }

    // ── Tier 2: Rule-based (numbers, dates, formats) ─────────
    const ruleResult = this.tryRuleBased(shielded.shieldedText);
    if (ruleResult && ruleResult.confidence >= 0.7) {
      const translated = this.identifierShield.unshield(ruleResult.english, shielded.tokens);
      this.cacheResult(cacheKey, translated, ruleResult.confidence, 2);
      return {
        blockId: block.blockId,
        originalText: text,
        translatedText: translated,
        confidence: ruleResult.confidence,
        tier: 2,
        method: 'rule_based',
        preservedIdentifiers,
        status: 'ok',
      };
    }

    // ── Tier 3: DeepL / Google Translation API ───────────────
    // (Placeholder — would call external API)
    const budget3 = this.budgetManager.canUse(documentId, 3, text.length);
    if (budget3.allowed) {
      // For now, pass through to AI fallback as tier 3
      // In production, this would call DeepL or Google Translate API
    }

    // ── Tier 4: GPT fallback (budget-controlled) ─────────────
    const estimatedTokens = Math.ceil(text.length / 2); // rough estimate
    const budget4 = this.budgetManager.canUse(documentId, 4, estimatedTokens);

    if (budget4.allowed) {
      try {
        const aiResult = await this.aiTranslation.invokeFallback({
          text: shielded.shieldedText,
          context: `Document type: ${context.documentType}. Section: ${context.section}. ` +
            `Glossary hints: ${context.glossaryHints.join(', ')}`,
        });

        this.budgetManager.recordUsage(documentId, estimatedTokens, budget4.model);

        if (aiResult && aiResult.translated) {
          const translated = this.identifierShield.unshield(
            aiResult.translated.text || shielded.shieldedText,
            shielded.tokens,
          );
          const confidence = Math.min(aiResult.confidence, 0.85); // Cap AI confidence
          this.cacheResult(cacheKey, translated, confidence, 4);
          return {
            blockId: block.blockId,
            originalText: text,
            translatedText: translated,
            confidence,
            tier: 4,
            method: `llm_${budget4.model}`,
            preservedIdentifiers,
            status: 'ok',
          };
        }
      } catch (err: any) {
        this.logger.warn(`AI translation failed for block ${block.blockId}: ${err.message}`);
      }
    }

    // ── Fallback: partial translation (glossary fragments + originals) ──
    const partialResult = await this.partialTranslation(text, shielded, context.tenantId);
    return {
      blockId: block.blockId,
      originalText: text,
      translatedText: partialResult.text,
      confidence: partialResult.confidence,
      tier: 1,
      method: 'partial_glossary',
      preservedIdentifiers,
      status: 'partial',
    };
  }

  // ── Tier helpers ───────────────────────────────────────────

  private async tryGlossary(
    text: string,
    tenantId?: string,
  ): Promise<{ english: string; confidence: number } | null> {
    try {
      const result = await this.glossaryService.translateTerm(text, 'product', tenantId);
      if (result && result.english) {
        return { english: result.english, confidence: result.confidence };
      }
    } catch {
      // Glossary miss is expected
    }
    return null;
  }

  private tryRuleBased(text: string): { english: string; confidence: number } | null {
    // Rule: Japanese date → ISO
    const dateMatch = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (dateMatch && text.length < 20) {
      const iso = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
      return { english: iso, confidence: 0.95 };
    }

    // Rule: Era date → western year
    const eraMatch = text.match(/(令和|平成|昭和)(\d{1,2})年(\d{1,2})月(\d{1,2})日/);
    if (eraMatch) {
      const eraBase: Record<string, number> = { '令和': 2018, '平成': 1988, '昭和': 1925 };
      const year = (eraBase[eraMatch[1]] || 2018) + parseInt(eraMatch[2]);
      const iso = `${year}-${eraMatch[3].padStart(2, '0')}-${eraMatch[4].padStart(2, '0')}`;
      return { english: iso, confidence: 0.95 };
    }

    // Rule: Currency
    const currMatch = text.match(/^[¥￥]\s?([\d,]+)$/);
    if (currMatch) {
      return { english: `¥${currMatch[1]}`, confidence: 0.95 };
    }

    // Rule: Pure number with commas
    if (/^[\d,]+$/.test(text.trim())) {
      return { english: text.trim(), confidence: 1.0 };
    }

    return null;
  }

  /**
   * Partial translation: translate known terms via glossary, keep rest as-is.
   */
  private async partialTranslation(
    originalText: string,
    shielded: ShieldedText,
    tenantId?: string,
  ): Promise<{ text: string; confidence: number }> {
    // Split into words/segments and translate each known segment
    const segments = originalText.split(/(\s+)/);
    let translated = '';
    let translatedCount = 0;

    for (const segment of segments) {
      if (segment.trim().length === 0) {
        translated += segment;
        continue;
      }

      const glossResult = await this.tryGlossary(segment.trim(), tenantId);
      if (glossResult && glossResult.confidence > 0.6) {
        translated += glossResult.english;
        translatedCount++;
      } else {
        translated += segment;
      }
    }

    const confidence = segments.length > 0
      ? Math.min(0.5, translatedCount / segments.filter((s) => s.trim()).length)
      : 0;

    return {
      text: this.identifierShield.unshield(translated, shielded.tokens),
      confidence,
    };
  }

  // ── Utilities ──────────────────────────────────────────────

  private containsJapanese(text: string): boolean {
    return /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf]/.test(text);
  }

  private calculateNumericRatio(text: string): number {
    const totalChars = text.length;
    if (totalChars === 0) return 0;
    const numericChars = (text.match(/[\d,.\-¥￥円]/g) || []).length;
    return numericChars / totalChars;
  }

  private cacheKey(text: string, context: TranslationContext): string {
    return `${text}||${context.documentType}||${context.section}`;
  }

  private cacheResult(key: string, translated: string, confidence: number, tier: number): void {
    this.cache.set(key, { translated, confidence, tier });
    // Evict oldest entries if cache gets too large
    if (this.cache.size > 10000) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
  }
}
