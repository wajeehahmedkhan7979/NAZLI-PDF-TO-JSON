import { Injectable, Logger } from '@nestjs/common';
import { PipelineMetrics } from '../../common/metrics/pipeline-metrics';
import { IngestionService } from '../ingestion/ingestion.service';
import { LlmBudgetManager } from '../translation/llm-budget-manager';
import { MarkerClient } from '../extraction/clients/marker.client';
import * as fs from 'fs';
import * as path from 'path';

export interface LoadTestOptions {
  concurrency: number;
  durationMs: number;
  datasetPath: string; // Directory containing sample PDFs
  profile?: 'steady' | 'spike' | 'mixed';
}

export interface LoadTestReport {
  throughput: {
    totalProcessed: number;
    docsPerMinute: number;
  };
  latency: Record<string, any>;
  cost: {
    totalCost: number;
    costPerDocument: number;
    costPer1kDocs: number;
    tierDistribution: Record<string, number>;
  };
  failures: {
    totalFailed: number;
    failureRate: number;
    categories: Record<string, number>;
  };
  scalingLimit: {
    bottleneck: string | null;
    evidence: any;
  };
}

@Injectable()
export class LoadTestService {
  private readonly logger = new Logger(LoadTestService.name);

  constructor(
    private readonly metrics: PipelineMetrics,
    private readonly ingestion: IngestionService,
    private readonly budgetManager: LlmBudgetManager,
    private readonly markerClient: MarkerClient,
  ) {}

  /**
   * Run a load test simulating high traffic.
   */
  async simulateLoad(options: LoadTestOptions): Promise<LoadTestReport> {
    this.logger.log(`Starting load test. Concurrency: ${options.concurrency}, Duration: ${options.durationMs}ms`);

    const files = fs.readdirSync(options.datasetPath).filter(f => f.endsWith('.pdf'));
    if (files.length === 0) {
      throw new Error(`No PDFs found in ${options.datasetPath}`);
    }

    const startTime = Date.now();
    let totalProcessed = 0;
    let totalFailed = 0;
    let failureCategories: Record<string, number> = {
      OCR_TIMEOUT: 0,
      SIDECAR_UNAVAILABLE: 0,
      TRANSLATION_FAIL: 0,
      VALIDATION_FAIL: 0,
      CAPACITY_REJECTED: 0,
    };

    // Keep track of active tasks
    let activeTasks = 0;
    const taskPromises: Promise<void>[] = [];

    const runWorker = async () => {
      while (Date.now() - startTime < options.durationMs) {
        // Pick random file
        const file = files[Math.floor(Math.random() * files.length)];
        const filePath = path.join(options.datasetPath, file);
        const buffer = fs.readFileSync(filePath);
        
        const mockFile: Express.Multer.File = {
          fieldname: 'file',
          originalname: file,
          encoding: '7bit',
          mimetype: 'application/pdf',
          size: buffer.length,
          stream: null as any,
          destination: '',
          filename: file,
          path: filePath,
          buffer: buffer,
        };

        try {
          // Send to ingestion (which queues it)
          await this.ingestion.processUpload(mockFile, 'load-test-tenant');
          totalProcessed++;
        } catch (err: any) {
          totalFailed++;
          if (err.status === 429 || err.message.includes('heavy load')) {
            failureCategories.CAPACITY_REJECTED++;
          } else {
            failureCategories.VALIDATION_FAIL++;
          }
        }
        
        // Brief artificial delay based on profile
        if (options.profile === 'steady') {
          await new Promise(r => setTimeout(r, 100));
        } else if (options.profile === 'spike') {
          // No delay
        }
      }
    };

    // Spin up concurrency workers
    for (let i = 0; i < options.concurrency; i++) {
      taskPromises.push(runWorker());
    }

    await Promise.all(taskPromises);

    const actualDuration = Date.now() - startTime;
    const docsPerMinute = (totalProcessed / actualDuration) * 60000;

    // Wait briefly for jobs to finish processing (optional, in real env they are queued)
    this.logger.log(`Load generation complete. Generating report...`);

    return this.generateReport(actualDuration, totalProcessed, totalFailed, failureCategories);
  }

  private generateReport(
    durationMs: number,
    processed: number,
    failed: number,
    failureCategories: Record<string, number>
  ): LoadTestReport {
    const snap = this.metrics.snapshot();
    const globalTierDistribution = this.budgetManager.getGlobalTierDistribution();
    
    // Calculate total cost assuming 100 tokens per tier4 hit and 1000 chars per tier3 hit for estimate
    // In reality, budgetManager tracks this per document. We can use a rough total or fetch from DB.
    // For now we use the metrics to estimate.
    const tier4Cost = globalTierDistribution.tier4 * 1000 * 0.00001; // dummy avg
    const tier3Cost = globalTierDistribution.tier3 * 2000 * 0.00002;
    const totalCost = tier4Cost + tier3Cost;
    const costPerDocument = processed > 0 ? totalCost / processed : 0;

    // Detect bottlenecks
    let bottleneck: string | null = null;
    let evidence: any = {};

    const extractP95 = snap.latencies['latency.extraction_ms']?.p95 || 0;
    
    if (failureCategories.CAPACITY_REJECTED > 0) {
      bottleneck = 'NODE_EVENT_LOOP_OR_QUEUE';
      evidence = { capacityRejections: failureCategories.CAPACITY_REJECTED };
    } else if (extractP95 > 15000) {
      bottleneck = 'MARKER_CPU';
      evidence = { extractionP95: extractP95 };
    } else if (globalTierDistribution.tier4 > 0 && totalCost > 1.0) {
      bottleneck = 'TRANSLATION_API_COST';
      evidence = { cost: totalCost, gptCalls: globalTierDistribution.tier4 };
    }

    return {
      throughput: {
        totalProcessed: processed,
        docsPerMinute: parseFloat((processed / (durationMs / 60000)).toFixed(2)),
      },
      latency: {
        extraction: snap.latencies['latency.extraction_ms'] || null,
        translation: snap.latencies['latency.translation_ms'] || null,
        mapping: snap.latencies['latency.mapping_ms'] || null,
      },
      cost: {
        totalCost: parseFloat(totalCost.toFixed(4)),
        costPerDocument: parseFloat(costPerDocument.toFixed(4)),
        costPer1kDocs: parseFloat((costPerDocument * 1000).toFixed(4)),
        tierDistribution: globalTierDistribution.distribution,
      },
      failures: {
        totalFailed: failed,
        failureRate: processed + failed > 0 ? failed / (processed + failed) : 0,
        categories: failureCategories,
      },
      scalingLimit: {
        bottleneck,
        evidence,
      },
    };
  }
}
