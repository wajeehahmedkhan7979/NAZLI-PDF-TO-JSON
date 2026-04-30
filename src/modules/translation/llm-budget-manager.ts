import { Injectable, Logger } from '@nestjs/common';

/**
 * LlmBudgetManager — controls LLM usage per document to prevent cost explosion.
 *
 * Tier target distribution (production target):
 *   Tier 1 Glossary:   40–60%
 *   Tier 2 Rule-based: 20–30%
 *   Tier 3 DeepL:      10–25%
 *   Tier 4 GPT:        <5%
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
    // Tier 3 (DeepL) cost estimation
    deeplCostPerChar: 0.0000200, // $20/million chars
  };

  /** Global tier hit counters (across all documents) */
  private globalTierHits = { tier1: 0, tier2: 0, tier3: 0, tier4: 0 };
  
  /** Global cost guardrail */
  private globalCostUsed = 0;
  private readonly maxGlobalCostPerDay = parseFloat(process.env.MAX_GLOBAL_COST_USD || '10.0');

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
      // Tier hit counters
      tier1Hits: 0,
      tier2Hits: 0,
      tier3Hits: 0,
      tier4Hits: 0,
      // Batch tracking
      batchCosts: [],
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
    // Phase 6: Global Cost Guardrail
    if (this.globalCostUsed >= this.maxGlobalCostPerDay) {
      if (tier === 4) {
        this.logger.error(`[GUARDRAIL] Global daily cost limit ($${this.maxGlobalCostPerDay}) exceeded. Disabling Tier 4 (GPT).`);
        return { allowed: false, model: '', reason: 'Global cost limit exceeded' };
      }
    }

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

    const cost = tokens * costPerToken;
    budget.tokensUsed += tokens;
    budget.costUsed += cost;
    this.globalCostUsed += cost;
    budget.requestCount++;
    budget.tier4Hits++;
    this.globalTierHits.tier4++;

    // Track batch cost
    budget.batchCosts.push({ tier: 4, cost, tokens, model });

    this.logger.debug(
      `[${documentId}] LLM usage: +${tokens} tokens (${model}). ` +
        `Total: ${budget.tokensUsed}/${this.defaults.maxTokensPerDoc} tokens, ` +
        `$${budget.costUsed.toFixed(4)}/$${this.defaults.maxCostPerDoc}`,
    );
  }

  /**
   * Record a tier 1 (glossary) hit.
   */
  recordTierHit(documentId: string, tier: 1 | 2 | 3 | 4, charCount = 0): void {
    const budget = this.activeBudgets.get(documentId);
    this.globalTierHits[`tier${tier}`]++;

    if (!budget) return;

    if (tier === 1) budget.tier1Hits++;
    else if (tier === 2) budget.tier2Hits++;
    else if (tier === 3) {
      budget.tier3Hits++;
      // Track DeepL cost estimate
      const cost = charCount * this.defaults.deeplCostPerChar;
      budget.costUsed += cost;
      this.globalCostUsed += cost;
      budget.batchCosts.push({ tier: 3, cost, tokens: 0, model: 'deepl' });
    }
    else if (tier === 4) budget.tier4Hits++;
  }

  /**
   * End a budget session and return summary.
   */
  endSession(documentId: string): DocumentBudgetSummary | null {
    const budget = this.activeBudgets.get(documentId);
    if (!budget) return null;

    const totalHits = budget.tier1Hits + budget.tier2Hits + budget.tier3Hits + budget.tier4Hits;

    const tierDistribution = totalHits > 0 ? {
      glossary: parseFloat((budget.tier1Hits / totalHits).toFixed(3)),
      ruleBased: parseFloat((budget.tier2Hits / totalHits).toFixed(3)),
      deepl: parseFloat((budget.tier3Hits / totalHits).toFixed(3)),
      gpt: parseFloat((budget.tier4Hits / totalHits).toFixed(3)),
    } : { glossary: 0, ruleBased: 0, deepl: 0, gpt: 0 };

    const summary: DocumentBudgetSummary = {
      documentId,
      tokensUsed: budget.tokensUsed,
      costUsed: parseFloat(budget.costUsed.toFixed(6)),
      requestCount: budget.requestCount,
      fallbackCount: budget.fallbackCount,
      deniedCount: budget.deniedCount,
      durationMs: Date.now() - budget.startedAt,
      // Tier tracking
      glossaryHits: budget.tier1Hits,
      ruleHits: budget.tier2Hits,
      deeplCalls: budget.tier3Hits,
      gptCalls: budget.tier4Hits,
      tierDistribution,
      // Warnings if targets are off
      tierWarnings: this.checkTierTargets(tierDistribution),
    };

    this.activeBudgets.delete(documentId);
    this.logger.log(
      `[${documentId}] Budget session ended: ${summary.tokensUsed} tokens, ` +
        `$${summary.costUsed.toFixed(4)}, ${summary.requestCount} requests ` +
        `(${summary.fallbackCount} fallback, ${summary.deniedCount} denied) | ` +
        `tiers: glossary=${(tierDistribution.glossary * 100).toFixed(0)}% ` +
        `rule=${(tierDistribution.ruleBased * 100).toFixed(0)}% ` +
        `deepl=${(tierDistribution.deepl * 100).toFixed(0)}% ` +
        `gpt=${(tierDistribution.gpt * 100).toFixed(0)}%`,
    );

    return summary;
  }

  /**
   * Get global tier distribution across all documents (since startup).
   */
  getGlobalTierDistribution(): {
    tier1: number; tier2: number; tier3: number; tier4: number;
    distribution: { glossary: number; ruleBased: number; deepl: number; gpt: number };
  } {
    const total = Object.values(this.globalTierHits).reduce((a, b) => a + b, 0) || 1;
    return {
      ...this.globalTierHits,
      distribution: {
        glossary: parseFloat((this.globalTierHits.tier1 / total).toFixed(3)),
        ruleBased: parseFloat((this.globalTierHits.tier2 / total).toFixed(3)),
        deepl: parseFloat((this.globalTierHits.tier3 / total).toFixed(3)),
        gpt: parseFloat((this.globalTierHits.tier4 / total).toFixed(3)),
      },
    };
  }

  /** Check if tier distribution hits production targets */
  private checkTierTargets(dist: {
    glossary: number; ruleBased: number; deepl: number; gpt: number;
  }): string[] {
    const warnings: string[] = [];
    if (dist.glossary < 0.40) warnings.push(`Glossary hit rate low (${(dist.glossary * 100).toFixed(0)}% < 40% target)`);
    if (dist.gpt > 0.05) warnings.push(`GPT usage high (${(dist.gpt * 100).toFixed(0)}% > 5% target)`);
    if (dist.ruleBased < 0.20) warnings.push(`Rule-based rate low (${(dist.ruleBased * 100).toFixed(0)}% < 20% target)`);
    return warnings;
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
  tier1Hits: number;
  tier2Hits: number;
  tier3Hits: number;
  tier4Hits: number;
  batchCosts: Array<{ tier: number; cost: number; tokens: number; model: string }>;
}

export interface DocumentBudgetSummary {
  documentId: string;
  tokensUsed: number;
  costUsed: number;
  requestCount: number;
  fallbackCount: number;
  deniedCount: number;
  durationMs: number;
  glossaryHits: number;
  ruleHits: number;
  deeplCalls: number;
  gptCalls: number;
  tierDistribution: { glossary: number; ruleBased: number; deepl: number; gpt: number };
  tierWarnings: string[];
}
