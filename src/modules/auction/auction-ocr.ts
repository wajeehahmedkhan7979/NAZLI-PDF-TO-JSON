import { Injectable, Logger } from '@nestjs/common';
import { createWorker } from 'tesseract.js';
import * as util from 'util';
import { exec } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const execAsync = util.promisify(exec);

@Injectable()
export class AuctionOcr {
  private readonly logger = new Logger(AuctionOcr.name);

  async extractText(pdfPath: string): Promise<string> {
    this.logger.log(`Running deterministic OCR for ${pdfPath}`);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-render-'));
    const outPrefix = path.join(outDir, 'page');
    
    try {
      // Render pages to images
      await execAsync(`pdftoppm -png -r 300 "${pdfPath}" "${outPrefix}"`);
      
      const files = fs.readdirSync(outDir);
      const imagePaths = files
        .filter(f => f.startsWith('page-') && f.endsWith('.png'))
        .map(f => path.join(outDir, f));

      // Numeric sort
      imagePaths.sort((a, b) => {
        const numA = parseInt(a.match(/-(\d+)\.png$/)?.[1] || '0', 10);
        const numB = parseInt(b.match(/-(\d+)\.png$/)?.[1] || '0', 10);
        return numA - numB;
      });

      this.logger.log(`Rendered ${imagePaths.length} pages to images`);

      // Initialize Tesseract worker
      const worker = await createWorker('jpn');

      let fullText = '';
      for (const img of imagePaths) {
        this.logger.debug(`OCRing ${img}...`);
        const { data: { text } } = await worker.recognize(img);
        fullText += text + '\n\n';
      }

      await worker.terminate();

      return fullText;
    } catch (err: any) {
      this.logger.error(`OCR failed: ${err.message}`);
      return '';
    } finally {
      // Cleanup
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }
}
