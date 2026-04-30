import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { OrchestratorService } from '../modules/orchestrator/orchestrator.service';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const orchestrator = app.get(OrchestratorService);

  const datasetsDir = path.resolve(process.cwd(), 'datasets/purchase');
  const baselineAccuracy = 0.99;
  
  if (!fs.existsSync(datasetsDir)) {
    console.error(`Datasets directory not found: ${datasetsDir}`);
    process.exit(1);
  }

  let currentWeightedScore = 0;
  let totalWeightedScore = 0;
  let correctChassis = 0, totalChassis = 0;
  let correctTotals = 0, totalTotals = 0;
  let failedDocs = 0;
  let totalDocsProcessed = 0;

  const folders = ['clean', 'noisy'];
  
  for (const folder of folders) {
    const dirPath = path.join(datasetsDir, folder);
    if (!fs.existsSync(dirPath)) {
      console.warn(`[SKIP] Folder ${folder} does not exist at ${dirPath}`);
      continue;
    }

    const files = fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith('.pdf'));
    console.log(`\n--- Evaluating ${folder} dataset (${files.length} files) ---`);

    for (const file of files) {
      totalDocsProcessed++;
      const pdfPath = path.join(dirPath, file);
      const expectedPath = pdfPath.substring(0, pdfPath.lastIndexOf('.')) + '.json';

      if (!fs.existsSync(expectedPath)) {
        console.warn(`[SKIP] No ground truth for ${file} at ${expectedPath}`);
        continue;
      }

      const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'));
      
      try {
        // 1. Ingest
        const doc = await prisma.document.create({
          data: {
            tenantId: 'test-tenant',
            fileHash: `test-hash-${file}-${Date.now()}`,
            originalName: file,
            storagePath: pdfPath,
            mimeType: 'application/pdf',
            fileSize: fs.statSync(pdfPath).size,
            status: 'QUEUED',
            stage: 'INGESTED',
            pipelineVersion: '2.0.0',
            extractionEngineVersion: 'marker',
          }
        });

        // 2. Run Pipeline
        await orchestrator.runPipeline(doc.id);
        
        // 3. Compare
        const result = await prisma.document.findUnique({ where: { id: doc.id } });
        const actual = result?.canonicalJson as any;

        const res = compareResults(expected, actual);
        currentWeightedScore += res.score;
        totalWeightedScore += res.maxScore;
        correctChassis += res.chassisC;
        totalChassis += res.chassisT;
        correctTotals += res.totalC;
        totalTotals += res.totalT;

        const accuracy = res.maxScore > 0 ? res.score / res.maxScore : 1;
        console.log(`[${accuracy >= baselineAccuracy ? 'PASS' : 'FAIL'}] ${file} - Acc: ${(accuracy * 100).toFixed(2)}%`);
        
        if (accuracy < baselineAccuracy) failedDocs++;

      } catch (err: any) {
        console.error(`[ERROR] ${file}: ${err.message}`);
        failedDocs++;
      }
    }
  }

  if (totalDocsProcessed === 0) {
    console.error('\n❌ No evaluation files found in clean/ or noisy/. Aborting.');
    process.exit(1);
  }

  const finalAccuracy = totalWeightedScore > 0 ? currentWeightedScore / totalWeightedScore : (failedDocs === 0 ? 1 : 0);
  const chassisAcc = totalChassis > 0 ? correctChassis / totalChassis : 1;
  const totalAcc = totalTotals > 0 ? correctTotals / totalTotals : 1;

  console.log(`\n========================================`);
  console.log(`Final Weighted Accuracy: ${(finalAccuracy * 100).toFixed(2)}% (Target: ${baselineAccuracy * 100}%)`);
  console.log(`Chassis Accuracy: ${(chassisAcc * 100).toFixed(2)}% (Target: 100%)`);
  console.log(`Total Price Accuracy: ${(totalAcc * 100).toFixed(2)}% (Target: 99%)`);
  console.log(`Total Documents Processed: ${totalDocsProcessed}`);
  console.log(`Failed Documents: ${failedDocs}`);
  console.log(`========================================`);

  if (finalAccuracy < baselineAccuracy || chassisAcc < 1.0 || totalAcc < 0.99 || failedDocs > 0) {
    console.error('REGRESSION DETECTED. Build failed.');
    process.exit(1);
  } else {
    console.log('REGRESSION CHECK PASSED.');
    process.exit(0);
  }
}

function compareResults(expected: any, actual: any): any {
  let score = 0;
  let maxScore = 0;
  let chassisC = 0, chassisT = 0;
  let totalC = 0, totalT = 0;

  if (!actual || !actual.records) return { score: 0, maxScore: 1, chassisC: 0, chassisT: 1, totalC: 0, totalT: 1 };

  const weights: any = {
    chassis: 0.30,
    bid: 0.20,
    total: 0.20,
    date: 0.10,
    auction: 0.10,
    lotNumber: 0.10,
  };

  for (const expRec of expected.records) {
    const actRec = actual.records.find((r: any) => r.chassis === expRec.chassis);
    
    for (const field of Object.keys(weights)) {
      const weight = weights[field];
      maxScore += weight;

      if (field === 'chassis') chassisT++;
      if (field === 'total') totalT++;

      if (actRec && actRec[field] === expRec[field]) {
        score += weight;
        if (field === 'chassis') chassisC++;
        if (field === 'total') totalC++;
      }
    }
  }

  return { score, maxScore, chassisC, chassisT, totalC, totalT };
}

bootstrap();
