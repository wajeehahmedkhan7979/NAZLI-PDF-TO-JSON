import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AiTranslationAdapter {
  translateStruct(japaneseData: any): Promise<any>;
}

@Injectable()
export class AiTranslationService {
  private readonly logger = new Logger(AiTranslationService.name);
  private enabled: boolean;

  constructor(private configService: ConfigService) {
    this.enabled = this.configService.get<string>('ai.provider') !== 'none';
  }

  async invokeFallback(normalizedData: any): Promise<{ translated: any, confidence: number }> {
    if (!this.enabled) {
      this.logger.debug('AI fallback disabled. Returning original data.');
      return { translated: normalizedData, confidence: 0.1 };
    }

    // Here we would call the LLM using structured output schema (e.g. OpenAI parsing)
    // Hardcoded mock to avoid network calls during scaffold
    this.logger.log('Mock AI fallback translation activated');
    
    return { 
      translated: {
        ...normalizedData,
        englishFallback: true
      }, 
      confidence: 0.7 
    };
  }
}
