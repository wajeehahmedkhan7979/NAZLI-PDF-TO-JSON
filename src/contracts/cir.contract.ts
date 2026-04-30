/**
 * Canonical Intermediate Representation (CIR)
 * The strict contract between Document Understanding and Segmentation/Mapping layers.
 */

export interface CIRBlock {
  id: string;
  type: 'TEXT' | 'TABLE' | 'KEY_VALUE' | 'HEADER' | 'FOOTER' | 'IDENTIFIER';
  content: {
    original: string;
    translated?: string;
    normalized?: string;
  };
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    page: number;
  };
  metadata: {
    confidence: number;
    section?: string;
    isShielded: boolean; // True for identifiers (VIN/Chassis)
  };
}

export interface CIRDocument {
  id: string;
  blocks: CIRBlock[];
  fingerprint: string; // Structural hash for reproducibility
  version: string;
}
