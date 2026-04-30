# Nazli PDF-to-JSON: Architecture & Repository Structure

This document outlines the system architecture and directory structure for the Japanese Purchase Document extraction pipeline.

## 1. System Architecture

The system is **constraint-driven with deterministic validation gates**, while utilizing probabilistic upstream layers (OCR, segmentation, and AI translation fallback). It is designed to transform unstructured Japanese PDF documents into highly consistent JSON payloads ready for ERP ingestion through strict schema and validation enforcement.

### High-Level Data Flow
```mermaid
graph TD
    A[PDF Ingestion] --> B[Classifier]
    B --> C[Extraction Layer (Probabilistic)]
    C --> D[Document Understanding (Heuristic)]
    D --> E[Segmentation (Multi-Signal)]
    E --> F[Tiered Translation (Hybrid)]
    F --> G[Schema Mapping (Deterministic Gate)]
    G --> H[Validation Layer (Strict Constraints)]
    H --> I[ERP Payload Export]
```

### Core Components
1. **Orchestrator**: Manages the state of each document through the pipeline stages (INGEST -> CLASSIFY -> EXTRACT -> ... -> OUTPUT).
2. **Marker Sidecar**: A Python-based FastAPI service running the `marker-pdf` engine for high-fidelity OCR and layout detection.
3. **Contract Layer (CIR)**: Defines the Canonical Intermediate Representation to ensure data integrity across pipeline boundaries.
4. **Understanding Layer**: Reconstructs fragmented OCR blocks into semantic structures (tables, key-value pairs).
5. **Segmentation Service**: Uses weighted signals (column fingerprints, keyword similarity) to split multi-document PDFs with reproducibility controls.
6. **Translation Engine**: A tiered approach (Glossary -> Rule-based -> AI Fallback). **Identifier-critical fields are strictly shielded from LLM mutation.**
7. **Validation & Quality Gate**: Enforces strict math (Subtotal + Tax = Total) and distribution checks.

---

## 2. Repository Structure

### `/src` - Application Source
- **`/contracts`**: The single source of truth for CIR and ERP integration schemas.
- **`/common`**: Shared guards, interceptors, and pipeline snapshot tracing.
- **`/database`**: Prisma schema and migration scripts.
- **`/modules`**:
    - **`orchestrator/`**: The pipeline state machine.
    - **`extraction/`**: Clients for Marker and legacy backends.
    - **`understanding/`**: Table reconstruction and block normalization.
    - **`segmentation/`**: Multi-signal document splitting.
    - **`translation/`**: Deterministic glossary and AI-powered translation.
    - **`normalization/`**: Data cleansing (dates, currency, characters).
    - **`schema-mapper/`**: Purchase-specific mapping and ERP adapter.
    - **`validation/`**: Correctness validation (math, schema, integrity).
    - **`analytics/`**: Distribution analysis and drift detection.
    - **`documents/`**: API controllers and storage management.
- **`/scripts`**: Evaluation and regression testing tools.

### `/marker-sidecar` - Python OCR Service
- `server.py`: FastAPI application.
- `Dockerfile`: Production-ready environment for marker-pdf.

### `/datasets` - Regression Testing
- **`purchase/clean/`**: Standard, high-quality documents + ground truth.
- **`purchase/noisy/`**: Skewed, multi-page, or low-res documents + ground truth.

---

## 3. Technology Stack
- **Framework**: NestJS (Node.js)
- **Database**: PostgreSQL + Prisma ORM
- **Cache**: Redis + BullMQ
- **OCR Engine**: Marker-PDF (Python)
- **AI/LLM**: GPT-4o / Claude 3.5 (via LangChain/Custom clients)
- **Validation**: Zod + Custom Math Validators
- **DevOps**: Docker Compose

## 4. Operational Guardrails
- **Critical Shielding**: VIN/Chassis and numeric identifiers are never processed by LLMs to prevent mutation.
- **Fail-Fast Math**: Documents with >1% math variance are flagged for manual review.
- **Deterministic Enforcement**: Downstream output is locked by strict schema contracts.
