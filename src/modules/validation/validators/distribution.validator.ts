import { Injectable } from '@nestjs/common';
import { PurchaseRecord } from '../../schema-mapper/schemas/purchase-record.schema';

export interface DistributionReport {
  totalVariance: number;
  bidToTotalRatio: number;
  outliers: string[]; // Chassis IDs of outliers
  duplicateChassis: string[];
  columnShiftRisk: boolean;
  distributionStability: number; // 0 to 1
}

@Injectable()
export class DistributionValidator {
  
  validate(records: PurchaseRecord[]): DistributionReport {
    if (records.length === 0) {
      return {
        totalVariance: 0,
        bidToTotalRatio: 0,
        outliers: [],
        duplicateChassis: [],
        columnShiftRisk: false,
        distributionStability: 1.0,
      };
    }

    const totals = records.map(r => r.total).filter(t => t > 0);

    // Variance & Mean
    const meanTotal = totals.length > 0 ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;
    const stdDev = totals.length > 0 
      ? Math.sqrt(totals.reduce((acc, val) => acc + Math.pow(val - meanTotal, 2), 0) / totals.length)
      : 0;
    const totalVariance = stdDev; // Using stdDev for variance field as requested by typical patterns

    // Bid to Total Ratio
    let validRatios = 0;
    let sumRatios = 0;
    records.forEach(r => {
      if (r.bid > 0 && r.total > 0) {
        sumRatios += (r.total / r.bid);
        validRatios++;
      }
    });
    const bidToTotalRatio = validRatios > 0 ? sumRatios / validRatios : 0;

    // Outliers (e.g. total is > mean + 2*stddev or < mean - 2*stddev, or extreme threshold)
    const outliers = records
      .filter(r => r.total > 0 && (r.total > meanTotal + 2 * stdDev || r.total < meanTotal * 0.1))
      .map(r => r.chassis || 'UNKNOWN');

    // Duplicates
    const chassisCounts: Record<string, number> = {};
    records.forEach(r => {
      if (r.chassis) {
        chassisCounts[r.chassis] = (chassisCounts[r.chassis] || 0) + 1;
      }
    });
    const duplicateChassis = Object.keys(chassisCounts).filter(k => chassisCounts[k] > 1);

    // Column Shift Risk (heuristic: if variance is wildly high or too many outliers, it's a sign of shifted columns mapping into totals)
    const columnShiftRisk = outliers.length > records.length * 0.3 || duplicateChassis.length > 0 || bidToTotalRatio > 2.0;

    // Stability Score
    let stability = 1.0;
    if (duplicateChassis.length > 0) stability -= 0.5;
    if (columnShiftRisk) stability -= 0.3;
    stability = Math.max(0, stability - (outliers.length * 0.05));

    return {
      totalVariance,
      bidToTotalRatio,
      outliers,
      duplicateChassis,
      columnShiftRisk,
      distributionStability: stability,
    };
  }
}
