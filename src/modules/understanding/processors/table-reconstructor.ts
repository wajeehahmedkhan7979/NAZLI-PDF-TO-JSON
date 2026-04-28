import { Injectable, Logger } from '@nestjs/common';
import {
  UnderstoodBlock,
  ReconstructedTable,
  TableRow,
  TableCell,
  TableConfidence,
} from '../interfaces/understanding.interfaces';

/**
 * TableReconstructor — reconstructs full table grids from extraction blocks.
 *
 * Input: blocks tagged as Table/TableGroup from Marker (may be fragmented cells)
 * Output: ReconstructedTable with proper row/column structure and granular confidence.
 */
@Injectable()
export class TableReconstructor {
  private readonly logger = new Logger(TableReconstructor.name);

  /** Clustering tolerances (pixels) — configurable for different doc types */
  private readonly ROW_CLUSTER_TOLERANCE = 8;
  private readonly COL_CLUSTER_TOLERANCE = 15;
  private readonly MIN_CELLS_PER_ROW = 2;

  /**
   * Find and reconstruct tables from the block list.
   */
  reconstructTables(blocks: UnderstoodBlock[]): ReconstructedTable[] {
    const tables: ReconstructedTable[] = [];

    // Find table-type blocks
    const tableBlocks = blocks.filter(
      (b) => b.blockType === 'Table' || b.blockType === 'TableGroup',
    );

    if (tableBlocks.length === 0) {
      // Try to detect implicit tables from aligned text blocks
      const implicitTables = this.detectImplicitTables(blocks);
      tables.push(...implicitTables);
    } else {
      // Process explicit table blocks
      for (let i = 0; i < tableBlocks.length; i++) {
        const table = this.reconstructFromTableBlock(tableBlocks[i], `table_${i}`);
        if (table) tables.push(table);
      }
    }

    this.logger.debug(`Reconstructed ${tables.length} tables`);
    return tables;
  }

  /**
   * Reconstruct a table from a Marker Table/TableGroup block.
   */
  private reconstructFromTableBlock(
    block: UnderstoodBlock,
    tableId: string,
  ): ReconstructedTable | null {
    // Extract cells from children or from HTML
    const cells = this.extractCells(block);
    if (cells.length === 0) return null;

    // Detect grid structure
    const { rows, columns } = this.detectGrid(cells);

    // Identify headers (first row is typically a header)
    const headerRow = rows.length > 0 ? rows[0] : null;
    const dataRows = rows.length > 1 ? rows.slice(1) : rows;

    // Compute confidence
    const confidence = this.computeTableConfidence(cells, rows, columns);

    return {
      tableId,
      page: block.page,
      headers: headerRow ? headerRow.cells : [],
      rows: dataRows,
      bbox: block.bbox,
      confidence,
    };
  }

  /**
   * Extract cells from a table block.
   */
  private extractCells(block: UnderstoodBlock): TableCell[] {
    const cells: TableCell[] = [];

    if (block.children && block.children.length > 0) {
      // Process children recursively
      this.collectCells(block.children as any[], cells, 0, 0);
    } else if (block.text) {
      // Try to parse text as table rows (tab/space delimited)
      const lines = block.text.split('\n').filter((l) => l.trim());
      for (let row = 0; row < lines.length; row++) {
        const parts = this.splitTableLine(lines[row]);
        for (let col = 0; col < parts.length; col++) {
          cells.push({
            text: parts[col].trim(),
            columnIndex: col,
            rowIndex: row,
            colSpan: 1,
            rowSpan: 1,
            confidence: block.confidence,
          });
        }
      }
    }

    return cells;
  }

  /**
   * Recursively collect cells from nested block tree.
   */
  private collectCells(
    blocks: any[],
    cells: TableCell[],
    defaultRow: number,
    defaultCol: number,
  ): void {
    for (const child of blocks) {
      if (!child) continue;

      const blockType = child.blockType || child.block_type || '';

      if (blockType === 'TableCell' || blockType === 'Cell') {
        cells.push({
          text: child.normalizedText || child.text || '',
          columnIndex: child.columnIndex ?? defaultCol,
          rowIndex: child.rowIndex ?? defaultRow,
          bbox: child.bbox,
          colSpan: child.colSpan ?? 1,
          rowSpan: child.rowSpan ?? 1,
          confidence: child.confidence ?? 0.7,
        });
      } else if (child.children && child.children.length > 0) {
        this.collectCells(child.children, cells, defaultRow, defaultCol);
      } else if (child.text || child.normalizedText) {
        // Treat as a single cell
        cells.push({
          text: child.normalizedText || child.text || '',
          columnIndex: defaultCol++,
          rowIndex: defaultRow,
          colSpan: 1,
          rowSpan: 1,
          confidence: child.confidence ?? 0.7,
        });
      }
    }
  }

  /**
   * Detect grid structure from cells using Y-coordinate clustering.
   */
  private detectGrid(cells: TableCell[]): { rows: TableRow[]; columns: number } {
    if (cells.length === 0) return { rows: [], columns: 0 };

    // If cells have bbox, use Y-coordinate clustering for rows
    const hasBbox = cells.some((c) => c.bbox && c.bbox.length >= 4);

    if (hasBbox) {
      // Cluster by Y-center for row detection
      const yCenters = cells.map((c) => {
        if (c.bbox && c.bbox.length >= 4) return (c.bbox[1] + c.bbox[3]) / 2;
        return c.rowIndex * 100; // fallback
      });
      const rowClusters = this.clusterValues(yCenters, this.ROW_CLUSTER_TOLERANCE);

      // Assign row indices based on clusters
      for (const [clusterIdx, memberIndices] of rowClusters.entries()) {
        for (const memberIdx of memberIndices) {
          cells[memberIdx].rowIndex = clusterIdx;
        }
      }

      // Cluster by X-left for column detection
      const xLefts = cells.map((c) => {
        if (c.bbox && c.bbox.length >= 4) return c.bbox[0];
        return c.columnIndex * 100;
      });
      const colClusters = this.clusterValues(xLefts, this.COL_CLUSTER_TOLERANCE);

      for (const [clusterIdx, memberIndices] of colClusters.entries()) {
        for (const memberIdx of memberIndices) {
          cells[memberIdx].columnIndex = clusterIdx;
        }
      }
    }

    // Group by row index
    const rowMap = new Map<number, TableCell[]>();
    for (const cell of cells) {
      if (!rowMap.has(cell.rowIndex)) rowMap.set(cell.rowIndex, []);
      rowMap.get(cell.rowIndex)!.push(cell);
    }

    // Sort rows and build TableRow objects, filtering out rows with too few cells
    const sortedRowIndices = Array.from(rowMap.keys()).sort((a, b) => a - b);
    const maxColumns = Math.max(...Array.from(rowMap.values()).map((r) => r.length), 0);

    const rows: TableRow[] = sortedRowIndices
      .filter((rowIdx) => {
        const rowCells = rowMap.get(rowIdx)!;
        // Skip rows with fewer cells than threshold (likely floating/noise)
        return rowCells.length >= this.MIN_CELLS_PER_ROW || rowCells.length >= maxColumns * 0.5;
      })
      .map((rowIdx, i) => {
        const rowCells = rowMap.get(rowIdx)!;
        rowCells.sort((a, b) => a.columnIndex - b.columnIndex);
        return {
          rowIndex: i,
          cells: rowCells,
          isMultiLine: false,
        };
      });

    return { rows, columns: maxColumns };
  }

  /**
   * Detect tables that aren't explicitly marked as Table blocks
   * but show tabular alignment (e.g., aligned columns of text).
   */
  private detectImplicitTables(blocks: UnderstoodBlock[]): ReconstructedTable[] {
    const tables: ReconstructedTable[] = [];

    // Group blocks by page
    const byPage = new Map<number, UnderstoodBlock[]>();
    for (const b of blocks) {
      if (!byPage.has(b.page)) byPage.set(b.page, []);
      byPage.get(b.page)!.push(b);
    }

    for (const [page, pageBlocks] of byPage) {
      // Look for runs of blocks with consistent X-alignment
      const textBlocks = pageBlocks.filter(
        (b) => b.blockType === 'Text' && b.bbox && b.normalizedText.length > 0,
      );

      if (textBlocks.length < 3) continue;

      // Cluster by X-position of left edge
      const xPositions = textBlocks.map((b) => b.bbox![0]);
      const clusters = this.clusterValues(xPositions, 10);

      // If we have 2+ columns with 3+ rows each, it's likely a table
      if (clusters.length >= 2) {
        const minRowsPerCluster = Math.min(
          ...clusters.map((c) => c.length),
        );
        if (minRowsPerCluster >= 3) {
          // Build implicit table
          const implicitCells: TableCell[] = [];
          for (let row = 0; row < textBlocks.length; row++) {
            const block = textBlocks[row];
            const colIdx = clusters.findIndex((c) =>
              c.some((idx) => Math.abs(xPositions[idx] - block.bbox![0]) < 10),
            );
            implicitCells.push({
              text: block.normalizedText,
              columnIndex: colIdx >= 0 ? colIdx : 0,
              rowIndex: row,
              bbox: block.bbox,
              colSpan: 1,
              rowSpan: 1,
              confidence: block.confidence * 0.8, // Reduced confidence for implicit
            });
          }

          const { rows, columns } = this.detectGrid(implicitCells);

          tables.push({
            tableId: `implicit_table_${page}`,
            page,
            headers: rows.length > 0 ? rows[0].cells : [],
            rows: rows.length > 1 ? rows.slice(1) : [],
            confidence: {
              gridIntegrity: 0.6,
              headerConfidence: 0.5,
              cellConsistency: 0.6,
              mergeAccuracy: 1.0,
              overall: 0.6,
            },
          });
        }
      }
    }

    return tables;
  }

  /**
   * Cluster numeric values with a tolerance threshold.
   */
  private clusterValues(values: number[], tolerance: number): number[][] {
    if (values.length === 0) return [];

    const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const clusters: number[][] = [[sorted[0].i]];

    for (let i = 1; i < sorted.length; i++) {
      const lastCluster = clusters[clusters.length - 1];
      const lastValue = sorted[i - 1].v;

      if (sorted[i].v - lastValue <= tolerance) {
        lastCluster.push(sorted[i].i);
      } else {
        clusters.push([sorted[i].i]);
      }
    }

    return clusters;
  }

  /**
   * Split a table line into cells using tabs, multiple spaces, or pipe delimiters.
   */
  private splitTableLine(line: string): string[] {
    // Try tab-delimited first
    if (line.includes('\t')) {
      return line.split('\t');
    }

    // Try pipe-delimited
    if (line.includes('|')) {
      return line.split('|').filter((s) => s.trim());
    }

    // Try multiple-space-delimited (3+ spaces)
    const parts = line.split(/\s{3,}/);
    if (parts.length > 1) return parts;

    // Single cell
    return [line];
  }

  /**
   * Compute granular table confidence.
   */
  private computeTableConfidence(
    cells: TableCell[],
    rows: TableRow[],
    columns: number,
  ): TableConfidence {
    // Grid integrity: how regular is the row/column structure?
    const rowLengths = rows.map((r) => r.cells.length);
    const avgRowLen = rowLengths.length > 0
      ? rowLengths.reduce((a, b) => a + b, 0) / rowLengths.length
      : 0;
    const rowLenVariance = rowLengths.length > 0
      ? rowLengths.reduce((acc, len) => acc + Math.pow(len - avgRowLen, 2), 0) / rowLengths.length
      : 0;
    const gridIntegrity = Math.max(0, 1 - rowLenVariance / Math.max(avgRowLen, 1));

    // Header confidence: does the first row look different from data rows?
    const headerConfidence = rows.length > 1 ? 0.8 : 0.5;

    // Cell consistency: are numeric columns consistent?
    const cellConsistency = this.computeCellConsistency(rows, columns);

    // Merge accuracy: for now assume no merges unless detected
    const mergeAccuracy = cells.some((c) => c.colSpan > 1 || c.rowSpan > 1) ? 0.7 : 1.0;

    const overall =
      gridIntegrity * 0.3 +
      headerConfidence * 0.2 +
      cellConsistency * 0.3 +
      mergeAccuracy * 0.2;

    return {
      gridIntegrity: parseFloat(gridIntegrity.toFixed(3)),
      headerConfidence: parseFloat(headerConfidence.toFixed(3)),
      cellConsistency: parseFloat(cellConsistency.toFixed(3)),
      mergeAccuracy: parseFloat(mergeAccuracy.toFixed(3)),
      overall: parseFloat(overall.toFixed(3)),
    };
  }

  /**
   * Check if column content types are consistent (all numbers, all text, etc.).
   */
  private computeCellConsistency(rows: TableRow[], columns: number): number {
    if (rows.length < 2 || columns === 0) return 0.5;

    let consistentCols = 0;
    for (let col = 0; col < columns; col++) {
      const values = rows
        .map((r) => r.cells[col]?.text || '')
        .filter((t) => t.trim().length > 0);

      if (values.length < 2) continue;

      const numericCount = values.filter((v) => /^[\d,.\-¥￥]+$/.test(v.trim())).length;
      const ratio = numericCount / values.length;

      // Column is consistent if mostly numeric or mostly text
      if (ratio > 0.7 || ratio < 0.3) consistentCols++;
    }

    return columns > 0 ? consistentCols / columns : 0.5;
  }
}
