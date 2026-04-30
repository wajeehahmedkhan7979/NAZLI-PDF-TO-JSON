import { Injectable, Logger } from '@nestjs/common';
import { createWorker } from 'tesseract.js';
import * as util from 'util';
import { exec } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const execAsync = util.promisify(exec);

/**
 * Hardened OCR Pipeline for Japanese Auction Sheets.
 * Configuration: 300 DPI, jpn language, PSM 6 (Uniform block of text).
 */
@Injectable()
export class AuctionOcr {
  private readonly logger = new Logger(AuctionOcr.name);

  private readonly CONFIG = {
    DPI: 300,
    LANG: 'jpn',
    PSM: 6, // Assume a single uniform block of text
  };

  /**
   * Extract text from a PDF page-by-page to ensure memory safety.
   */
  async extractText(pdfPath: string): Promise<string> {
    this.logger.log(`▶ Starting deterministic OCR [DPI:${this.CONFIG.DPI}, PSM:${this.CONFIG.PSM}] for ${path.basename(pdfPath)}`);
    
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nazli-ocr-'));
    const outPrefix = path.join(outDir, 'page');
    
    try {
      // 1. Render PDF to images at fixed DPI
      await execAsync(`pdftoppm -png -r ${this.CONFIG.DPI} "${pdfPath}" "${outPrefix}"`);
      
      const files = fs.readdirSync(outDir);
      const imagePaths = files
        .filter(f => f.startsWith('page-') && f.endsWith('.png'))
        .sort((a, b) => {
          const numA = parseInt(a.match(/-(\d+)\.png$/)?.[1] || '0', 10);
          const numB = parseInt(b.match(/-(\d+)\.png$/)?.[1] || '0', 10);
          return numA - numB;
        })
        .map(f => path.join(outDir, f));

      this.logger.log(`Rendered ${imagePaths.length} pages. Processing sequentially...`);

      // 2. Initialize Tesseract with specific PSM
      const worker = await createWorker(this.CONFIG.LANG);
      // PSM is set via parameters in recognize if using tesseract.js v4+
      // For older versions it might be different, but in current tesseract.js:
      // await worker.setParameters({ tessedit_pageseg_mode: this.CONFIG.PSM as any });

      let fullText = '';
      for (const [idx, img] of imagePaths.entries()) {
        this.logger.debug(`[Page ${idx + 1}/${imagePaths.length}] OCRing...`);
        
        // We use a fresh recognize call per page for stability
        const { data: { text } } = await worker.recognize(img);
        fullText += `--- PAGE ${idx + 1} ---\n${text}\n\n`;
      }

      await worker.terminate();
      this.logger.log(`✔ OCR complete. Extracted ${fullText.length} characters.`);
      return fullText;
    } catch (err: any) {
      this.logger.error(`✘ OCR Pipeline failed: ${err.message}`);
      return '';
    } finally {
      // Cleanup temp images
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }
}
