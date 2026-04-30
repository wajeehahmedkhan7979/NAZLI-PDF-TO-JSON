import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { LoggerModule } from 'nestjs-pino';
import { configuration, envValidationSchema } from './config/configuration';

// Feature modules
import { HealthModule } from './modules/health/health.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { ClassifierModule } from './modules/classifier/classifier.module';
import { AuctionModule } from './modules/auction/auction.module';
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
    AuctionModule,
    OrchestratorModule,
    MetricsModule,
    CacheModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
