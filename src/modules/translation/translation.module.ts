import { Module } from '@nestjs/common';
import { IdentifierShield } from './identifier-shield';
import { LlmBudgetManager } from './llm-budget-manager';
import { BlockTranslator } from './block-translator';
import { GlossaryService } from './deterministic/glossary.service';
import { AiTranslationService } from './ai-fallback/ai-translation.service';
import { DeepLProvider, NoOpTranslationProvider, TranslationProviderFactory } from './providers/translation-provider';

@Module({
  providers: [
    IdentifierShield,
    LlmBudgetManager,
    BlockTranslator,
    GlossaryService,
    AiTranslationService,
    DeepLProvider,
    NoOpTranslationProvider,
    TranslationProviderFactory,
  ],
  exports: [
    IdentifierShield,
    LlmBudgetManager,
    BlockTranslator,
    GlossaryService,
    AiTranslationService,
    TranslationProviderFactory,
  ],
})
export class TranslationModule {}
