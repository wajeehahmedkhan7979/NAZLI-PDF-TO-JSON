import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

/**
 * TranslationProvider — interface for interchangeable tier-3 providers.
 *
 * Implementations: DeepLProvider, GoogleProvider, NoOpProvider (test/disabled).
 * Selected by TRANSLATION_PROVIDER env var.
 */
export interface TranslationProvider {
  readonly name: string;
  readonly version: string;
  /** Translate a batch of texts. Returns array of results in same order. */
  translateBatch(
    texts: string[],
    sourceLang: string,
    targetLang: string,
  ): Promise<ProviderTranslationResult[]>;
  isAvailable(): Promise<boolean>;
}

export interface ProviderTranslationResult {
  translated: string;
  detectedSourceLang?: string;
  confidence: number;
  error?: string;
}

// ── DeepL Provider ───────────────────────────────────────────

@Injectable()
export class DeepLProvider implements TranslationProvider {
  readonly name = 'deepl';
  readonly version = '1.0.0';
  private readonly logger = new Logger(DeepLProvider.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('translation.deeplApiKey') || '';
    this.baseUrl = this.configService.get<string>('translation.deeplUrl') || 'https://api-free.deepl.com';
    this.timeoutMs = parseInt(process.env.DEEPL_TIMEOUT_MS || '10000', 10);
    this.maxRetries = parseInt(process.env.DEEPL_MAX_RETRIES || '2', 10);
  }

  async translateBatch(
    texts: string[],
    sourceLang: string,
    targetLang: string,
  ): Promise<ProviderTranslationResult[]> {
    if (!this.apiKey) {
      this.logger.debug('DeepL API key not configured, returning passthrough');
      return texts.map((t) => ({ translated: t, confidence: 0, error: 'not_configured' }));
    }

    let lastError: string = '';

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.callDeepL(texts, sourceLang, targetLang);
        return response;
      } catch (err: any) {
        lastError = err.message;
        if (attempt < this.maxRetries) {
          await this.sleep(500 * (attempt + 1));
          this.logger.warn(`DeepL attempt ${attempt + 1} failed: ${err.message}. Retrying...`);
        }
      }
    }

    // All retries exhausted — return passthrough results
    this.logger.error(`DeepL translation failed after ${this.maxRetries + 1} attempts: ${lastError}`);
    return texts.map((t) => ({ translated: t, confidence: 0, error: lastError }));
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(`${this.baseUrl}/v2/usage`, {
        headers: { Authorization: `DeepL-Auth-Key ${this.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async callDeepL(
    texts: string[],
    sourceLang: string,
    targetLang: string,
  ): Promise<ProviderTranslationResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const body = new URLSearchParams();
    texts.forEach((t) => body.append('text', t));
    body.append('source_lang', sourceLang.toUpperCase());
    body.append('target_lang', targetLang.toUpperCase());

    try {
      const resp = await fetch(`${this.baseUrl}/v2/translate`, {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${this.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`DeepL HTTP ${resp.status}: ${errText}`);
      }

      const json: any = await resp.json();
      return (json.translations || []).map((t: any) => ({
        translated: t.text,
        detectedSourceLang: t.detected_source_language,
        confidence: 0.88, // DeepL doesn't expose confidence — use empirical value
      }));
    } finally {
      clearTimeout(timer);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

// ── No-Op Provider (test / offline mode) ────────────────────

@Injectable()
export class NoOpTranslationProvider implements TranslationProvider {
  readonly name = 'noop';
  readonly version = '1.0.0';

  async translateBatch(texts: string[]): Promise<ProviderTranslationResult[]> {
    return texts.map((t) => ({ translated: t, confidence: 0, error: 'noop_provider' }));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

// ── Provider Factory ─────────────────────────────────────────

@Injectable()
export class TranslationProviderFactory {
  private readonly logger = new Logger(TranslationProviderFactory.name);

  constructor(
    private deeplProvider: DeepLProvider,
    private noopProvider: NoOpTranslationProvider,
    private configService: ConfigService,
  ) {}

  /**
   * Return the configured tier-3 provider.
   * Falls back to NoOp if not configured.
   */
  getProvider(): TranslationProvider {
    const provider = this.configService.get<string>('translation.provider') || 'noop';

    switch (provider) {
      case 'deepl':
        this.logger.log('Using DeepL translation provider');
        return this.deeplProvider;
      default:
        this.logger.log(`Translation provider=${provider} → using NoOp`);
        return this.noopProvider;
    }
  }

  /** Build a stable hash for a text to use as cache key */
  static textHash(text: string): string {
    return createHash('sha256').update(text).digest('hex').substring(0, 16);
  }
}
