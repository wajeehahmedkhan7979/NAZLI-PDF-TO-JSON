import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { OrchestratorService } from '../orchestrator.service';

@Processor('document-pipeline')
export class DocumentPipelineProcessor {
  private readonly logger = new Logger(DocumentPipelineProcessor.name);

  constructor(private readonly orchestrator: OrchestratorService) {}

  @Process('process-document')
  async handleProcessDocument(job: Job<{ documentId: string; tenantId: string }>) {
    const { documentId, tenantId } = job.data;
    this.logger.log(`Job ${job.id} started for document ${documentId} (tenant: ${tenantId})`);

    try {
      await job.progress(10);
      await this.orchestrator.runPipeline(documentId);
      await job.progress(100);

      this.logger.log(`Job ${job.id} completed successfully`);
      return { success: true, documentId };
    } catch (err: any) {
      this.logger.error(`Job ${job.id} failed: ${err.message}`);
      throw err; // Triggers BullMQ retry logic
    }
  }
}
