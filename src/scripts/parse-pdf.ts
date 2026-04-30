import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AuctionSheetProcessor } from '../modules/auction/auction-sheet.processor';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import * as fs from 'fs';

const prisma = new PrismaClient();

async function bootstrap() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: npm run parse <path-to-pdf>');
    process.exit(1);
  }

  const absolutePath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`File not found: ${absolutePath}`);
    process.exit(1);
  }

  console.log(`--- Nazli PDF-to-JSON CLI ---`);
  console.log(`Processing: ${path.basename(absolutePath)}`);

  const app = await NestFactory.createApplicationContext(AppModule);
  const processor = app.get(AuctionSheetProcessor);

  try {
    // 1. Create a dummy document record for the processor
    const documentId = `cli-${Date.now()}`;
    await prisma.document.create({
      data: {
        id: documentId,
        tenantId: 'cli-user',
        fileHash: `hash-${documentId}`,
        originalName: path.basename(absolutePath),
        storagePath: absolutePath,
        mimeType: 'application/pdf',
        fileSize: fs.statSync(absolutePath).size,
        status: 'PROCESSING',
      }
    });

    // 2. Run the processor directly
    const result = await processor.process(documentId);

    // 3. Output results
    console.log(`\n--- EXTRACTION RESULT ---`);
    console.log(JSON.stringify(result.payload, null, 2));
    console.log(`\n--- METADATA ---`);
    console.log(`Confidence: ${(result.confidence * 100).toFixed(2)}%`);
    console.log(`Flags: ${result.flags.join(', ') || 'NONE'}`);

    process.exit(0);
  } catch (err: any) {
    console.error(`\n❌ Extraction failed: ${err.message}`);
    process.exit(1);
  } finally {
    await app.close();
  }
}

bootstrap();
