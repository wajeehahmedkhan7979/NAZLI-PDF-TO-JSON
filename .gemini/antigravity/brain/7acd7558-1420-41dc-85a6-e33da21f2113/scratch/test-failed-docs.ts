import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { OrchestratorService } from '../src/modules/orchestrator/orchestrator.service';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';

const prisma = new PrismaClient();

async function testFailedFiles() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const orchestrator = app.get(OrchestratorService);

  const files = [
    'datasets/purchase/clean/USS NAGOYA  2.19.2026.pdf',
    'datasets/purchase/clean/USS OSAKA 2.19.2026.pdf',
    'datasets/purchase/clean/doc1.pdf'
  ];

  for (const file of files) {
    const pdfPath = path.resolve(process.cwd(), file);
    console.log(`\n--- Testing ${file} ---`);

    try {
      const doc = await prisma.document.create({
        data: {
          tenantId: 'test-tenant',
          fileHash: `test-failed-${path.basename(file)}-${Date.now()}`,
          originalName: path.basename(file),
          storagePath: pdfPath,
          mimeType: 'application/pdf',
          fileSize: 0,
          status: 'QUEUED',
          stage: 'INGESTED',
          pipelineVersion: '2.0.0',
          extractionEngineVersion: 'marker',
        }
      });

      await orchestrator.runPipeline(doc.id);
      console.log(`[PASS] ${file}`);
    } catch (err: any) {
      console.error(`[FAIL] ${file}: ${err.message}`);
    }
  }

  process.exit(0);
}

testFailedFiles();
