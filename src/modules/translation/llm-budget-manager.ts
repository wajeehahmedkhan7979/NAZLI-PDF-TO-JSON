import { Injectable, Logger } from '@nestjs/common';

/**
 * LlmBudgetManager — controls LLM usage per document to prevent cost explosion.
 *
 * Rules:
 * - LLM ONLY for: ambiguous tables, untranslated segments
 * - LLM NEVER for: identifiers, numeric fields, codes
 * - Each document has a token/cost budget
 * - When budget exceeded: fall back to cheaper model or skip LLM
 */
@Injectable()
export class LlmBudgetManager {
  private readonly logger = new Logger(LlmBudgetManager.name);

  /** Per-document budget state */
  private activeBudgets = new Map<string, DocumentBudget>();

  /** Default budget limits */
  private readonly defaults = {
    maxTokensPerDoc: 10000,
    maxCostPerDoc: 0.05, // USD
    primaryModel: 'gpt-4o-mini',
    fallbackModel: 'gpt-3.5-turbo',
    tokenCostPrimary: 0.00001,   // $/token (approx for gpt-4o-mini)
    tokenCostFallback: 0.000002, // $/token (approx for gpt-3.5-turbo)
  };

  /**
   * Start a budget session for a document.
   */
  startSession(documentId: string): void {
    this.activeBudgets.set(documentId, {
      documentId,
      tokensUsed: 0,
      costUsed: 0,
      requestCount: 0,
      fallbackCount: 0,
      deniedCount: 0,
      startedAt: Date.now(),
    });
  }

  /**
   * Check if LLM usage is allowed for the given tier.
   * Tier 3 = DeepL/Google (cheaper), Tier 4 = GPT (expensive)
   */
  canUse(
    documentId: string,
    tier: 3 | 4,
    estimatedTokens: number,
  ): { allowed: boolean; model: string; reason?: string } {
    const budget = this.activeBudgets.get(documentId);
    if (!budget) {
      return { allowed: false, model: this.defaults.primaryModel, reason: 'No active session' };
    }

    // Tier 3 (DeepL/Google) — always allowed (cost is controlled externally)
    if (tier === 3) {
      return { allowed: true, model: 'deepl' };
    }

    // Tier 4 (GPT) — budget-controlled
    const estimatedCost = estimatedTokens * this.defaults.tokenCostPrimary;

    // Check token budget
    if (budget.tokensUsed + estimatedTokens > this.defaults.maxTokensPerDoc) {
      // Try fallback model (cheaper)
      const fallbackCost = estimatedTokens * this.defaults.tokenCostFallback;
      if (budget.costUsed + fallbackCost <= this.defaults.maxCostPerDoc) {
        budget.fallbackCount++;
        this.logger.warn(
          `[${documentId}] Token budget near limit. Falling back to ${this.defaults.fallbackModel}`,
        );
        return { allowed: true, model: this.defaults.fallbackModel, reason: 'Token budget, using fallback' };
      }

      budget.deniedCount++;
      this.logger.warn(`[${documentId}] LLM budget exhausted. Denying request.`);
      return { allowed: false, model: '', reason: 'Token budget exhausted' };
    }

    // Check cost budget
    if (budget.costUsed + estimatedCost > this.defaults.maxCostPerDoc) {
      // Try fallback
      const fallbackCost = estimatedTokens * this.defaults.tokenCostFallback;
      if (budget.costUsed + fallbackCost <= this.defaults.maxCostPerDoc) {
        budget.fallbackCount++;
        return { allowed: true, model: this.defaults.fallbackModel, reason: 'Cost budget, using fallback' };
      }

      budget.deniedCount++;
      return { allowed: false, model: '', reason: 'Cost budget exhausted' };
    }

    return { allowed: true, model: this.defaults.primaryModel };
  }

  /**
   * Record actual LLM usage after a request completes.
   */
  recordUsage(documentId: string, tokens: number, model: string): void {
    const budget = this.activeBudgets.get(documentId);
    if (!budget) return;

    const costPerToken = model.includes('3.5')
      ? this.defaults.tokenCostFallback
      : this.defaults.tokenCostPrimary;

    budget.tokensUsed += tokens;
    budget.costUsed += tokens * costPerToken;
    budget.requestCount++;

    this.logger.debug(
      `[${documentId}] LLM usage: +${tokens} tokens (${model}). ` +
        `Total: ${budget.tokensUsed}/${this.defaults.maxTokensPerDoc} tokens, ` +
        `$${budget.costUsed.toFixed(4)}/$${this.defaults.maxCostPerDoc}`,
    );
  }

  /**
   * End a budget session and return summary.
   */
  endSession(documentId: string): DocumentBudgetSummary | null {
    const budget = this.activeBudgets.get(documentId);
    if (!budget) return null;

    const summary: DocumentBudgetSummary = {
      documentId,
      tokensUsed: budget.tokensUsed,
      costUsed: budget.costUsed,
      requestCount: budget.requestCount,
      fallbackCount: budget.fallbackCount,
      deniedCount: budget.deniedCount,
      durationMs: Date.now() - budget.startedAt,
    };

    this.activeBudgets.delete(documentId);
    this.logger.log(
      `[${documentId}] Budget session ended: ${summary.tokensUsed} tokens, ` +
        `$${summary.costUsed.toFixed(4)}, ${summary.requestCount} requests ` +
        `(${summary.fallbackCount} fallback, ${summary.deniedCount} denied)`,
    );

    return summary;
  }
}

// ── Internal types ───────────────────────────────────────────

interface DocumentBudget {
  documentId: string;
  tokensUsed: number;
  costUsed: number;
  requestCount: number;
  fallbackCount: number;
  deniedCount: number;
  startedAt: number;
}

export interface DocumentBudgetSummary {
  documentId: string;
  tokensUsed: number;
  costUsed: number;
  requestCount: number;
  fallbackCount: number;
  deniedCount: number;
  durationMs: number;
}
