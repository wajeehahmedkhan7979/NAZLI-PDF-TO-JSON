import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';
import { FileValidatorService } from './validators/file-validator.service';
import { VirusScannerService } from './validators/virus-scanner.service';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [
    StorageModule,
    BullModule.registerQueue({
      name: 'document-pipeline',
    }),
  ],
  controllers: [IngestionController],
  providers: [
    IngestionService,
    FileValidatorService,
    VirusScannerService,
  ],
  exports: [IngestionService],
})
export class IngestionModule {}
