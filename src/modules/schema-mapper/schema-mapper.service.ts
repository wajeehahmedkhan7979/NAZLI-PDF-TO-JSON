import { Injectable, Logger } from '@nestjs/common';
import { FieldCandidate } from '../understanding/interfaces/understanding.interfaces';
import { TranslatedBlock } from '../translation/block-translator';
import { PurchaseRecord } from './schemas/purchase-record.schema';

/**
 * MappingTrace — debug output showing how each field was mapped.
 * Critical for production debugging.
 */
export interface FieldMapping {
  field: string;
  value: any;
  sourceBlockId: string;
  rawValue: string;
  mappingConfidence: number;
  candidatesConsidered: number;
}

export interface RowTrace {
  rowId: string;
  sourceBlocks: string[];
  selectedCandidates: Array<{ field: string; value: any; confidence: number }>;
  rejectedCandidates: FieldCandidate[];
  mappingScores: {
    verticalAlignment: number;
    fieldCount: number;
    numericPattern: number;
    overall: number;
  };
  validationResult: 'PASS' | 'FAIL';
}

export interface MappingResult {
  canonicalOutput: any;
  mappingTrace: {
    fieldMappings: FieldMapping[];
    rowTraces: RowTrace[];
    unmappedCandidates: FieldCandidate[];
    warnings: string[];
  };
}

/**
 * SchemaMapperService — dispatches to the correct mapper by document type.
 */
@Injectable()
export class SchemaMapperService {
  private readonly logger = new Logger(SchemaMapperService.name);

  constructor() {}

  /**
   * Map field candidates and translated blocks to canonical output.
   */
  map(
    documentType: string,
    fieldCandidates: FieldCandidate[],
    translatedBlocks: TranslatedBlock[],
    documentId: string,
  ): MappingResult {
    this.logger.log(`Mapping ${fieldCandidates.length} candidates (Purchase only mode)`);
    
    // In "Purchase only" mode, we treat everything as a purchase or auction sheet row extraction
    return mapPurchase(fieldCandidates, translatedBlocks, documentId);
  }
}

// ── Mapping implementations ─────────────────────────────────

function pickBest(candidates: FieldCandidate[], fieldType: string): FieldCandidate | null {
  const matches = candidates
    .filter((c) => c.fieldType === fieldType)
    .sort((a, b) => b.confidence - a.confidence);
  return matches.length > 0 ? matches[0] : null;
}

function pickAll(candidates: FieldCandidate[], fieldType: string): FieldCandidate[] {
  return candidates
    .filter((c) => c.fieldType === fieldType)
    .sort((a, b) => b.confidence - a.confidence);
}

function toMapping(field: string, candidate: FieldCandidate | null, candidateCount: number): FieldMapping | null {
  if (!candidate) return null;
  return {
    field,
    value: candidate.value,
    sourceBlockId: candidate.sourceBlockId,
    rawValue: candidate.value,
    mappingConfidence: candidate.confidence,
    candidatesConsidered: candidateCount,
  };
}

function parseCurrency(value: string): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[¥￥,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}


function calculateRowScores(
  chassis: FieldCandidate,
  rowCandidates: FieldCandidate[],
  record: Partial<PurchaseRecord>
) {
  // 1. Vertical Alignment (Variance of Y-centers)
  const yCenters = rowCandidates
    .map(c => (c.metadata?.bbox?.[1]! + c.metadata?.bbox?.[3]!) / 2)
    .filter(y => !isNaN(y));
  
  let verticalAlignment = 1.0;
  if (yCenters.length > 1) {
    const avg = yCenters.reduce((a, b) => a + b, 0) / yCenters.length;
    const variance = yCenters.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / yCenters.length;
    verticalAlignment = Math.max(0, 1 - (variance / 100)); // 10px variance = 0.9 score
  }

  // 2. Column Consistency (Horizontal ordering and non-overlap)
  const sortedX = rowCandidates
    .filter(c => c.metadata?.bbox)
    .sort((a, b) => a.metadata!.bbox![0] - b.metadata!.bbox![0]);
  
  let overlaps = 0;
  for (let i = 0; i < sortedX.length - 1; i++) {
    if (sortedX[i].metadata!.bbox![2] > sortedX[i+1].metadata!.bbox![0] + 5) {
      overlaps++;
    }
  }
  const columnConsistency = Math.max(0, 1 - (overlaps / Math.max(1, sortedX.length)));

  // 3. Field Count (Density)
  const totalPossible = 11;
  const populated = Object.values(record).filter(v => !!v && v !== 0).length;
  const fieldCount = populated / totalPossible;

  // 4. Numeric Pattern (Validity of prices)
  const priceFields = [record.bid, record.recycle, record.jidosha, record.auctionFee, record.total];
  const validPrices = priceFields.filter(p => typeof p === 'number' && p >= 0).length;
  const numericPattern = validPrices / priceFields.length;

  const overall = (verticalAlignment * 0.3) + (columnConsistency * 0.2) + (fieldCount * 0.25) + (numericPattern * 0.25);

  return { verticalAlignment, columnConsistency, fieldCount, numericPattern, overall };
}

function validateRowHardConstraints(record: Partial<PurchaseRecord>): boolean {
  const currentYear = new Date().getFullYear();
  
  // Year Guard: 1990 to next year
  if (record.year && (record.year < 1990 || record.year > currentYear + 1)) return false;
  
  // Price Guard: bid must be > 0 (unless we strictly only have fees, but usually bid > 0)
  if (record.bid !== undefined && record.bid <= 0 && record.total > 0) return false;
  
  // Total Guard: total must be >= bid
  if (record.total && record.bid && record.total < record.bid) return false;
  
  // Recycle Guard: cannot be negative
  if (record.recycle !== undefined && record.recycle < 0) return false;

  return true;
}

function mapPurchase(
  candidates: FieldCandidate[],
  blocks: TranslatedBlock[],
  documentId: string,
): MappingResult {
  const mappings: FieldMapping[] = [];
  const rowTraces: RowTrace[] = [];
  const warnings: string[] = [];

  const chassisCandidates = pickAll(candidates, 'CHASSIS');
  const records: PurchaseRecord[] = [];

  for (let i = 0; i < chassisCandidates.length; i++) {
    const chassis = chassisCandidates[i];
    const rowId = `row_${i}`;

    // Apply Section Confidence Decay: 
    // If sectionAlignment is low, we penalize the candidate's base confidence
    const applyDecay = (c: FieldCandidate) => {
      if (c.confidenceBreakdown && c.confidenceBreakdown.sectionAlignment < 0.6) {
        return c.confidence * 0.6; // 40% reduction
      }
      return c.confidence;
    };

    const rowCandidates = candidates.filter(c => {
      if (c.sourceBlockId === chassis.sourceBlockId) return true;
      if (!c.metadata?.bbox || !chassis.metadata?.bbox) return false;
      
      const cy = (c.metadata.bbox[1] + c.metadata.bbox[3]) / 2;
      const chy = (chassis.metadata.bbox[1] + chassis.metadata.bbox[3]) / 2;
      
      const by = c.metadata.bbox[3]; // Baseline
      const bhy = chassis.metadata.bbox[3];
      
      const yDist = Math.abs(cy - chy);
      const baseDist = Math.abs(by - bhy);
      
      let clusterScore = 0;
      
      // Y-Center proximity (Weight 0.5)
      if (yDist < 10) clusterScore += 0.5;
      else if (yDist < 20) clusterScore += 0.2; // Allows for skewed rows
      
      // Baseline alignment (Weight 0.3)
      if (baseDist < 8) clusterScore += 0.3;
      else if (baseDist < 15) clusterScore += 0.1;
      
      // Column Anchor Alignment (Weight 0.2)
      // High-importance structural fields usually share stricter alignment
      const isColumnAnchor = ['TOTAL', 'BID', 'YEAR', 'LOT_NUMBER'].includes(c.fieldType);
      if (isColumnAnchor && yDist < 15) clusterScore += 0.2;
      
      // Accept if score is >= 0.5
      return clusterScore >= 0.5;
    }).map(c => ({ ...c, confidence: applyDecay(c) }));

    const record: Partial<PurchaseRecord> = {
      chassis: chassis.value,
      date: pickBest(rowCandidates, 'DATE')?.value || pickBest(candidates, 'DATE')?.value || '',
      auction: pickBest(rowCandidates, 'AUCTION')?.value || pickBest(candidates, 'AUCTION')?.value || '',
      area: pickBest(rowCandidates, 'AREA')?.value || pickBest(candidates, 'AREA')?.value || '',
      lotNumber: pickBest(rowCandidates, 'LOT_NUMBER')?.value || '',
      year: parseInt(pickBest(rowCandidates, 'YEAR')?.value?.replace(/[^0-9]/g, '') || '0'),
      bid: parseCurrency(pickBest(rowCandidates, 'BID')?.value) || 0,
      recycle: parseCurrency(pickBest(rowCandidates, 'RECYCLE')?.value) || 0,
      jidosha: parseCurrency(pickBest(rowCandidates, 'JIDOSHA')?.value) || 0,
      auctionFee: parseCurrency(pickBest(rowCandidates, 'AUCTION_FEE')?.value) || 0,
      total: parseCurrency(pickBest(rowCandidates, 'TOTAL')?.value) || 0,
    };

    const scores = calculateRowScores(chassis, rowCandidates, record);
    const passesConstraints = validateRowHardConstraints(record);
    
    const trace: RowTrace = {
      rowId,
      sourceBlocks: [...new Set(rowCandidates.map(c => c.sourceBlockId))],
      selectedCandidates: Object.entries(record).map(([k, v]) => ({
        field: k,
        value: v,
        confidence: pickBest(rowCandidates, k.toUpperCase())?.confidence || 0
      })),
      rejectedCandidates: rowCandidates.filter(c => !Object.values(record).includes(c.value)),
      mappingScores: scores,
      validationResult: (scores.overall > 0.65 && passesConstraints) ? 'PASS' : 'FAIL'
    };

    rowTraces.push(trace);

    if (trace.validationResult === 'PASS') {
      records.push(record as PurchaseRecord);
    } else {
      warnings.push(`Row ${i} (${chassis.value}) failed hard constraints or confidence check (Score: ${scores.overall.toFixed(2)}).`);
    }
  }

  if (records.length === 0) {
    warnings.push('No valid purchase rows detected after hardening.');
  }

  const hasTaxSignal = candidates.some(c => c.fieldType === 'TAX');

  const canonicalOutput = {
    type: 'PURCHASE',
    documentId,
    records,
    hasTaxSignal,
    summary: {
      totalRows: records.length,
      totalValue: records.reduce((sum, r) => sum + r.total, 0)
    }
  };

  return {
    canonicalOutput,
    mappingTrace: {
      fieldMappings: mappings,
      rowTraces,
      unmappedCandidates: candidates.filter(c => !rowTraces.some(t => t.sourceBlocks.includes(c.sourceBlockId))),
      warnings,
    },
  };
}


