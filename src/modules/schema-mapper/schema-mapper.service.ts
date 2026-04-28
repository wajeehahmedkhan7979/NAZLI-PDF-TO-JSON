import { Injectable, Logger } from '@nestjs/common';
import { FieldCandidate } from '../understanding/interfaces/understanding.interfaces';
import { TranslatedBlock } from '../translation/block-translator';

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

export interface MappingResult {
  canonicalOutput: any;
  mappingTrace: {
    fieldMappings: FieldMapping[];
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

  constructor(
    private purchaseMapper: PurchaseMapper,
    private billingMapper: BillingMapper,
    private auctionMapper: AuctionMapper,
  ) {}

  /**
   * Map field candidates and translated blocks to canonical output.
   */
  map(
    documentType: string,
    fieldCandidates: FieldCandidate[],
    translatedBlocks: TranslatedBlock[],
    documentId: string,
  ): MappingResult {
    this.logger.log(`Mapping ${fieldCandidates.length} candidates for type=${documentType}`);

    switch (documentType) {
      case 'PURCHASE':
        return this.purchaseMapper.map(fieldCandidates, translatedBlocks, documentId);
      case 'BILLING':
      case 'INVOICE':
        return this.billingMapper.map(fieldCandidates, translatedBlocks, documentId);
      case 'AUCTION_SHEET':
        return this.auctionMapper.map(fieldCandidates, translatedBlocks, documentId);
      default:
        this.logger.warn(`Unknown document type ${documentType}, attempting billing mapper`);
        return this.billingMapper.map(fieldCandidates, translatedBlocks, documentId);
    }
  }
}

// ── Forward declarations for DI (implementations below) ─────
@Injectable()
export class PurchaseMapper {
  map(candidates: FieldCandidate[], blocks: TranslatedBlock[], docId: string): MappingResult {
    return mapPurchase(candidates, blocks, docId);
  }
}

@Injectable()
export class BillingMapper {
  map(candidates: FieldCandidate[], blocks: TranslatedBlock[], docId: string): MappingResult {
    return mapBilling(candidates, blocks, docId);
  }
}

@Injectable()
export class AuctionMapper {
  map(candidates: FieldCandidate[], blocks: TranslatedBlock[], docId: string): MappingResult {
    return mapAuction(candidates, blocks, docId);
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

function mapPurchase(
  candidates: FieldCandidate[],
  blocks: TranslatedBlock[],
  documentId: string,
): MappingResult {
  const mappings: FieldMapping[] = [];
  const warnings: string[] = [];

  const chassis = pickBest(candidates, 'CHASSIS');
  const vin = pickBest(candidates, 'VIN');
  const vehicleName = pickBest(candidates, 'VEHICLE_NAME');
  const modelCode = pickBest(candidates, 'MODEL_CODE');
  const buyer = pickBest(candidates, 'CLIENT') || pickBest(candidates, 'BUYER');
  const seller = pickBest(candidates, 'VENDOR') || pickBest(candidates, 'SELLER');
  const total = pickBest(candidates, 'TOTAL');
  const subtotal = pickBest(candidates, 'SUBTOTAL');
  const tax = pickBest(candidates, 'TAX');
  const date = pickBest(candidates, 'DATE');
  const auctionFee = pickBest(candidates, 'AUCTION_FEE');
  const recycleFee = pickBest(candidates, 'RECYCLE_FEE');
  const lotNumber = pickBest(candidates, 'LOT_NUMBER');

  // Track mappings
  const fieldMap: Array<[string, FieldCandidate | null, string]> = [
    ['vehicle.chassis', chassis || vin, 'CHASSIS'],
    ['vehicle.name', vehicleName, 'VEHICLE_NAME'],
    ['vehicle.modelCode', modelCode, 'MODEL_CODE'],
    ['parties.buyer', buyer, 'CLIENT'],
    ['parties.seller', seller, 'VENDOR'],
    ['pricing.total', total, 'TOTAL'],
    ['pricing.subtotal', subtotal, 'SUBTOTAL'],
    ['pricing.tax', tax, 'TAX'],
    ['pricing.auctionFee', auctionFee, 'AUCTION_FEE'],
    ['pricing.recycleFee', recycleFee, 'RECYCLE_FEE'],
    ['dates.purchaseDate', date, 'DATE'],
    ['identifiers.lotNumber', lotNumber, 'LOT_NUMBER'],
  ];

  for (const [field, candidate, type] of fieldMap) {
    const all = pickAll(candidates, type);
    const mapping = toMapping(field, candidate, all.length);
    if (mapping) mappings.push(mapping);
  }

  // Warnings for missing required fields
  if (!chassis && !vin) warnings.push('Missing: vehicle identifier (VIN/chassis)');
  if (!total) warnings.push('Missing: total price');
  if (!buyer && !seller) warnings.push('Missing: both buyer and seller');

  const canonicalOutput = {
    type: 'PURCHASE',
    documentId,
    parties: {
      buyer: buyer?.value || null,
      seller: seller?.value || null,
    },
    vehicle: {
      vin: vin?.value || null,
      chassis: chassis?.value || null,
      modelCode: modelCode?.value || null,
      name: vehicleName?.value || null,
    },
    pricing: {
      total: parseCurrency(total?.value),
      subtotal: parseCurrency(subtotal?.value),
      tax: parseCurrency(tax?.value),
      auctionFee: parseCurrency(auctionFee?.value),
      recycleFee: parseCurrency(recycleFee?.value),
    },
    dates: {
      purchaseDate: date?.value || null,
    },
    identifiers: {
      lotNumber: lotNumber?.value || null,
    },
    lineItems: blocks
      .filter((b) => b.status !== 'failed')
      .map((b) => ({
        originalDescription: b.originalText,
        englishDescription: b.translatedText,
        confidence: b.confidence,
      })),
  };

  return {
    canonicalOutput,
    mappingTrace: {
      fieldMappings: mappings,
      unmappedCandidates: candidates.filter(
        (c) => !mappings.some((m) => m.sourceBlockId === c.sourceBlockId && m.rawValue === c.value),
      ),
      warnings,
    },
  };
}

function mapBilling(
  candidates: FieldCandidate[],
  blocks: TranslatedBlock[],
  documentId: string,
): MappingResult {
  const mappings: FieldMapping[] = [];
  const warnings: string[] = [];

  const vendor = pickBest(candidates, 'VENDOR');
  const client = pickBest(candidates, 'CLIENT');
  const invoiceNumber = pickBest(candidates, 'INVOICE_NUMBER');
  const total = pickBest(candidates, 'TOTAL');
  const subtotal = pickBest(candidates, 'SUBTOTAL');
  const tax = pickBest(candidates, 'TAX');
  const date = pickBest(candidates, 'DATE');
  const bankAccount = pickBest(candidates, 'BANK_ACCOUNT');

  const fieldMap: Array<[string, FieldCandidate | null, string]> = [
    ['vendor', vendor, 'VENDOR'],
    ['client', client, 'CLIENT'],
    ['invoiceNumber', invoiceNumber, 'INVOICE_NUMBER'],
    ['totals.total', total, 'TOTAL'],
    ['totals.subtotal', subtotal, 'SUBTOTAL'],
    ['totals.tax', tax, 'TAX'],
    ['invoiceDate', date, 'DATE'],
    ['paymentDetails.bankAccount', bankAccount, 'BANK_ACCOUNT'],
  ];

  for (const [field, candidate, type] of fieldMap) {
    const all = pickAll(candidates, type);
    const mapping = toMapping(field, candidate, all.length);
    if (mapping) mappings.push(mapping);
  }

  if (!invoiceNumber) warnings.push('Missing: invoice number');
  if (!total) warnings.push('Missing: total amount');

  const canonicalOutput = {
    type: 'BILLING',
    documentId,
    vendor: vendor?.value || null,
    client: client?.value || null,
    invoiceNumber: invoiceNumber?.value || null,
    invoiceDate: date?.value || null,
    lineItems: blocks
      .filter((b) => b.status !== 'failed')
      .map((b) => ({
        originalDescription: b.originalText,
        englishDescription: b.translatedText,
        confidence: b.confidence,
      })),
    totals: {
      subtotal: parseCurrency(subtotal?.value),
      tax: parseCurrency(tax?.value),
      total: parseCurrency(total?.value),
    },
    paymentDetails: {
      bankAccount: bankAccount?.value || null,
    },
  };

  return {
    canonicalOutput,
    mappingTrace: {
      fieldMappings: mappings,
      unmappedCandidates: candidates.filter(
        (c) => !mappings.some((m) => m.sourceBlockId === c.sourceBlockId && m.rawValue === c.value),
      ),
      warnings,
    },
  };
}

function mapAuction(
  candidates: FieldCandidate[],
  blocks: TranslatedBlock[],
  documentId: string,
): MappingResult {
  // Auction sheets are handled by the existing AuctionSheetProcessor.
  // This mapper wraps the output into the unified MappingResult format.
  const mappings: FieldMapping[] = [];
  const warnings: string[] = [];

  const allChassis = pickAll(candidates, 'CHASSIS');
  const date = pickBest(candidates, 'DATE');
  const vendor = pickBest(candidates, 'VENDOR');

  for (const c of allChassis) {
    mappings.push({
      field: `vehicles[${mappings.length}].chassis`,
      value: c.value,
      sourceBlockId: c.sourceBlockId,
      rawValue: c.value,
      mappingConfidence: c.confidence,
      candidatesConsidered: allChassis.length,
    });
  }

  if (allChassis.length === 0) warnings.push('No chassis numbers found');

  const canonicalOutput = {
    type: 'AUCTION_SHEET',
    documentId,
    auctionDate: date?.value || null,
    issuer: vendor?.value || null,
    vehicleCount: allChassis.length,
    vehicles: allChassis.map((c) => ({
      chassis: c.value,
      confidence: c.confidence,
    })),
    lineItems: blocks
      .filter((b) => b.status !== 'failed')
      .map((b) => ({
        originalDescription: b.originalText,
        englishDescription: b.translatedText,
        confidence: b.confidence,
      })),
  };

  return {
    canonicalOutput,
    mappingTrace: {
      fieldMappings: mappings,
      unmappedCandidates: candidates.filter(
        (c) => c.fieldType !== 'CHASSIS',
      ),
      warnings,
    },
  };
}
