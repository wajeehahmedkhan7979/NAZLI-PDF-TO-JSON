import { z } from 'zod';

export const envValidationSchema = z.object({
  PORT: z.string().transform(Number).default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_KEY: z.string().min(8),

  DATABASE_URL: z.string().url(),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().transform(Number).default('6379'),

  STORAGE_DIR: z.string().default('./storage'),
  MAX_FILE_SIZE_MB: z.string().transform(Number).default('20'),
  MAX_PAGES: z.string().transform(Number).default('100'),

  TESSERACT_LANG: z.string().default('jpn'),
  MIN_OCR_CONFIDENCE: z.string().transform(Number).default('0.6'),

  AI_PROVIDER: z.enum(['none', 'openai', 'anthropic']).default('none'),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  // Translation provider (tier-3)
  TRANSLATION_PROVIDER: z.enum(['deepl', 'google', 'noop']).default('noop'),
  DEEPL_API_KEY: z.string().optional(),
  DEEPL_URL: z.string().default('https://api-free.deepl.com'),

  // Marker sidecar circuit breaker
  MARKER_SIDECAR_URL: z.string().default('http://localhost:8001'),
  MARKER_TIMEOUT_MS: z.string().transform(Number).default('600000'),
  MARKER_MAX_RETRIES: z.string().transform(Number).default('3'),
  MARKER_CB_FAILURE_THRESHOLD: z.string().transform(Number).default('5'),
  MARKER_CB_RECOVERY_MS: z.string().transform(Number).default('30000'),

  // Cache TTLs (seconds)
  CACHE_TTL_EXTRACTION_S: z.string().transform(Number).default('86400'),
  CACHE_TTL_TRANSLATION_S: z.string().transform(Number).default('604800'),
  CACHE_TTL_SEGMENTATION_S: z.string().transform(Number).default('86400'),
});

export const configuration = () => {
  const env = envValidationSchema.parse(process.env);

  return {
    app: {
      port: env.PORT,
      env: env.NODE_ENV,
      apiKey: env.API_KEY,
    },
    database: {
      url: env.DATABASE_URL,
    },
    redis: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
    },
    storage: {
      dir: env.STORAGE_DIR,
      maxSize: env.MAX_FILE_SIZE_MB * 1024 * 1024,
      maxPages: env.MAX_PAGES,
    },
    ocr: {
      tesseractLang: env.TESSERACT_LANG,
      minConfidence: env.MIN_OCR_CONFIDENCE,
    },
    ai: {
      provider: env.AI_PROVIDER,
      openaiKey: env.OPENAI_API_KEY,
      anthropicKey: env.ANTHROPIC_API_KEY,
    },
    translation: {
      provider: env.TRANSLATION_PROVIDER,
      deeplApiKey: env.DEEPL_API_KEY,
      deeplUrl: env.DEEPL_URL,
    },
    marker: {
      url: env.MARKER_SIDECAR_URL,
      timeoutMs: env.MARKER_TIMEOUT_MS,
      maxRetries: env.MARKER_MAX_RETRIES,
      circuitBreaker: {
        failureThreshold: env.MARKER_CB_FAILURE_THRESHOLD,
        recoveryTimeMs: env.MARKER_CB_RECOVERY_MS,
      },
    },
    cache: {
      ttl: {
        extraction: env.CACHE_TTL_EXTRACTION_S,
        translation: env.CACHE_TTL_TRANSLATION_S,
        segmentation: env.CACHE_TTL_SEGMENTATION_S,
      },
    },
  };
};
