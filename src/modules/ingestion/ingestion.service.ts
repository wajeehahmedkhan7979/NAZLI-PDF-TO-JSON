import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bull';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { StorageAdapter } from '../storage/adapters/storage-adapter.interface';
import { FileValidatorService } from './validators/file-validator.service';
import { VirusScannerService } from './validators/virus-scanner.service';
import { calculateFileHash } from '../../common/utils/hash.util';

const prisma = new PrismaClient();

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @Inject('STORAGE_ADAPTER') private storageAdapter: StorageAdapter,
    @InjectQueue('document-pipeline') private pipelineQueue: Queue,
    private fileValidator: FileValidatorService,
    private scanner: VirusScannerService,
  ) {}

  private readonly MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || '100', 10);

  async processUpload(file: Express.Multer.File, tenantId: string) {
    this.logger.log(`Processing upload for tenant ${tenantId}`);

    // 0. Backpressure Control
    const counts = await this.pipelineQueue.getJobCounts();
    const activeAndWaiting = counts.waiting + counts.active;
    if (activeAndWaiting >= this.MAX_QUEUE_SIZE) {
      this.logger.warn(`Backpressure activated: Queue at capacity (${activeAndWaiting}/${this.MAX_QUEUE_SIZE})`);
      throw new BadRequestException('System is under heavy load. Please try again later.');
    }

    // 1. Validation
    await this.fileValidator.validatePdf(file.buffer, file.originalname, file.mimetype);

    // 2. Hash & Dedup
    const fileHash = calculateFileHash(file.buffer);
    const existingDoc = await prisma.document.findFirst({
      where: { fileHash, tenantId }
    });

    if (existingDoc && existingDoc.status !== 'FAILED') {
      this.logger.warn(`Duplicate document detected: ${fileHash}`);
      // Depending on business rules, we could reject or return existing. Returning existing for idempotency.
      return {
        documentId: existingDoc.id,
        jobId: `dup_${existingDoc.id}`,
        status: existingDoc.status,
      };
    }

    const documentId = uuidv4();

    // 3. Storage
    const storagePath = await this.storageAdapter.save(file.buffer, file.originalname, documentId, tenantId);

    // 4. Virus Scan
    const isSafe = await this.scanner.scanFile(storagePath);
    if (!isSafe) {
      // Delete the unsafe file
      await this.storageAdapter.delete(storagePath);
      throw new BadRequestException('File failed security scan');
    }

    // 5. Database Record Creation
    const document = await prisma.document.create({
      data: {
        id: documentId,
        tenantId,
        fileHash,
        originalName: file.originalname,
        storagePath,
        mimeType: file.mimetype,
        fileSize: file.size,
        status: 'QUEUED',
        stage: 'INGESTED',
      }
    });

    // 6. Audit Log
    await prisma.auditLog.create({
      data: {
        documentId,
        action: 'uploaded',
        stage: 'INGESTED',
        actor: 'user', // Would come from auth context in a real app
        details: { size: file.size, originalName: file.originalname }
      }
    });

    // 7. Dispatch to Queue with Prioritization
    // Small files (< 1MB) get Priority 1 (High). Larger get Priority 2 (Low).
    const priority = file.size < 1024 * 1024 ? 1 : 2;

    const job = await this.pipelineQueue.add('process-document', { documentId, tenantId }, {
      jobId: documentId, // ensures job idempotency in BullMQ
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      priority
    });

    this.logger.log(`Document ${documentId} queued for processing in job ${job.id}`);

    return {
      documentId,
      jobId: job.id,
      status: 'QUEUED'
    };
  }
}
