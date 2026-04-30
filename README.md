# NAZLI-PDF-TO-JSON (Hardened)

> Production-safe, deterministic extraction service for Japanese Purchase PDFs (Auction Sheets).

## Core Philosophy

- **Deterministic-First**: No LLMs for core extraction. Uses regex-based positional heuristics.
- **Production-Safe**: Linear pipeline with strict validation. No silent failures.
- **Minimalist**: 80% of legacy AI/hybrid modules pruned. Optimized for local execution.
- **ERP-Ready**: Outputs strict `PurchaseRecord` JSON schema.

## Pipeline Architecture

```
Ingestion → Classification → Deterministic Parsing → Mapping → Validation → Audit
```

1. **Ingestion**: File validation, virus scanning, and storage.
2. **Classification**: Identifies if the document is an auction sheet.
3. **Parsing**: Regex-first extraction of chassis numbers, dates, and lots.
4. **Mapping**: Normalizes Japanese fields to English PurchaseRecords.
5. **Validation**: Enforces mathematical parity (Price ≈ Bid + Fees) and schema integrity.

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Run Local Parser (CLI)
```bash
npm run parse <path-to-pdf>
```

### 3. Accuracy Evaluation
```bash
npm run evaluate
```

## Project Structure

```
src/
├── modules/
│   ├── auction/        # Core Purchase Extraction Engine (Regex + Logic)
│   ├── classifier/     # Document Type Detection
│   ├── ingestion/      # File Upload & Validation
│   ├── orchestrator/   # Linear Pipeline Driver
│   └── storage/        # File Management
├── common/
│   └── schemas/        # PurchaseRecord Zod Schema
└── scripts/            # CLI Tools & Evaluation Harness
```

## Schema: PurchaseRecord

| Field | Description |
|-------|-------------|
| `date` | ISO 8601 Date |
| `auction` | Platform Name |
| `area` | English Area Name |
| `chassis` | Vehicle Chassis ID |
| `bid` | Starting Bid |
| `total` | Final Winning Price |
| `confidence` | Extraction Score (0.0 - 1.0) |

## Development

- **DB**: Postgres 16 (via Prisma)
- **Queue**: Redis (via BullMQ)
- **OCR**: Poppler + Tesseract (for scanned documents)

For setup instructions, see [REPRODUCE.md](./REPRODUCE.md).
