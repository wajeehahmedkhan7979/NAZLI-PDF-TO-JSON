/**
 * Explicit Failure Taxonomy for the Japanese PDF Pipeline.
 * Used for observability, regression classification, and CI gating.
 */
export enum FailureType {
  // Upstream / Infrastructure
  SIDECAR_UNAVAILABLE = 'SIDECAR_UNAVAILABLE',
  OCR_FAILURE = 'OCR_FAILURE',
  
  // Logical / Probabilistic Layers
  CLASSIFICATION_AMBIGUITY = 'CLASSIFICATION_AMBIGUITY',
  SEGMENTATION_DRIFT = 'SEGMENTATION_DRIFT',
  UNDERSTANDING_FRAGMENTATION = 'UNDERSTANDING_FRAGMENTATION',
  
  // Translation & Consistency
  TRANSLATION_INCONSISTENCY = 'TRANSLATION_INCONSISTENCY',
  IDENTIFIER_MUTATION_ATTEMPT = 'IDENTIFIER_MUTATION_ATTEMPT',
  
  // Deterministic Constraints
  MATH_VALIDATION_FAIL = 'MATH_VALIDATION_FAIL',
  SCHEMA_MISMATCH = 'SCHEMA_MISMATCH',
  CONTRACT_VIOLATION = 'CONTRACT_VIOLATION',
  
  // System
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN',
}

export interface PipelineFailure {
  type: FailureType;
  stage: string;
  message: string;
  details?: any;
  timestamp: Date;
}
