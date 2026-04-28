import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { LoggerModule } from 'nestjs-pino';
import { configuration, envValidationSchema } from './config/configuration';

// Feature modules
import { HealthModule } from './modules/health/health.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { ClassifierModule } from './modules/classifier/classifier.module';
import { ExtractionModule } from './modules/extraction/extraction.module';
import { UnderstandingModule } from './modules/understanding/understanding.module';
import { SegmentationModule } from './modules/segmentation/segmentation.module';
import { NormalizationModule } from './modules/normalization/normalization.module';
import { TranslationModule } from './modules/translation/translation.module';
import { ValidationModule } from './modules/validation/validation.module';
import { SchemaMapperModule } from './modules/schema-mapper/schema-mapper.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { ReviewModule } from './modules/review/review.module';
import { OrchestratorModule } from './modules/orchestrator/orchestrator.module';
import { MetricsModule } from './modules/health/metrics.module';
import { CacheModule } from './common/cache/cache.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: (env) => {
        const result = envValidationSchema.safeParse(env);
        if (!result.success) {
          throw new Error(`Config validation error: ${result.error.message}`);
        }
        return result.data;
      },
    }),

    // Logging
    LoggerModule.forRoot({
      pinoHttp: {
        transport: process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
        level: process.env.NODE_ENV !== 'production' ? 'debug' : 'info',
      },
    }),

    // Redis Queue (BullMQ)
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
    }),

    // ─── Feature Modules ─────────────────────────────
    HealthModule,
    IngestionModule,
    ClassifierModule,
    ExtractionModule,
    UnderstandingModule,
    SegmentationModule,
    NormalizationModule,
    TranslationModule,
    ValidationModule,
    SchemaMapperModule,
    DocumentsModule,
    ReviewModule,
    OrchestratorModule,
    MetricsModule,
    CacheModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
