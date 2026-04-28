# NAZLI-PDF-TO-JSON

> Production-grade pipeline for extracting structured English JSON from Japanese purchase PDFs.

## Architecture

```
Upload PDF → Virus Scan → Store → Classify → Extract → Normalize → Translate → Validate → Quality Gate → API
```

**Primary path:** Deterministic extraction + glossary-based translation + schema validation  
**Fallback path:** AI/LLM for ambiguous or messy documents  
**Control path:** Human review queue for low-confidence or high-value records  

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose (for PostgreSQL + Redis)

### 1. Install dependencies

```bash
npm install
```

### 2. Start infrastructure

```bash
docker-compose up -d
```

This starts:
- **PostgreSQL 16** on port `5432`
- **Redis 7** on port `6379`

### 3. Setup database

```bash
# Generate Prisma client
npx prisma generate --schema=src/database/prisma/schema.prisma

# Push schema to database
npx prisma db push --schema=src/database/prisma/schema.prisma

# Seed glossary dictionary
npx ts-node src/database/seed/glossary.seed.ts
```

### 4. Run the application

```bash
npm run start:dev
```

The API will be available at `http://localhost:3000`.  
Swagger docs at `http://localhost:3000/api/docs`.

## API Endpoints

All endpoints require the `X-API-Key` header (default: `local-dev-key-12345`).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/documents/upload` | Upload a Japanese PDF |
| `GET` | `/api/v1/documents` | List documents (paginated, filterable) |
| `GET` | `/api/v1/documents/:id` | Document detail (frontend format) |
| `GET` | `/api/v1/documents/:id/canonical` | Internal canonical JSON |
| `GET` | `/api/v1/documents/:id/raw` | Download original PDF |
| `GET` | `/api/v1/documents/:id/extractions` | Raw extraction results |
| `GET` | `/api/v1/documents/:id/audit` | Full audit trail |
| `POST` | `/api/v1/documents/:id/reprocess` | Re-queue for processing |
| `GET` | `/api/v1/review/queue` | Documents needing review |
| `POST` | `/api/v1/review/:id/approve` | Approve (with corrections) |
| `POST` | `/api/v1/review/:id/reject` | Reject with reason |
| `GET` | `/health` | Health check |

## Usage Example

### Upload a PDF

```bash
curl -X POST http://localhost:3000/api/v1/documents/upload \
  -H "X-API-Key: local-dev-key-12345" \
  -H "X-Tenant-Id: my-company" \
  -F "file=@invoice.pdf"
```

Response:
```json
{
  "documentId": "abc-123-...",
  "jobId": "abc-123-...",
  "status": "QUEUED"
}
```

### Get translated document

```bash
curl http://localhost:3000/api/v1/documents/abc-123-... \
  -H "X-API-Key: local-dev-key-12345"
```

Response (frontend format):
```json
{
  "id": "abc-123-...",
  "vendorName": "Sample Co., Ltd.",
  "documentDate": "2026-04-14",
  "documentType": "INVOICE",
  "status": "COMPLETED",
  "summary": {
    "currency": "JPY",
    "subtotal": 9000,
    "tax": 900,
    "total": 9900
  },
  "items": [
    {
      "description": "Industrial bolt M10",
      "originalDescription": "工業用ボルト M10",
      "quantity": 200,
      "unit": "pcs",
      "unitPrice": 45,
      "lineTotal": 9000
    }
  ],
  "source": {
    "originalLanguage": "ja",
    "confidence": 0.94
  },
  "flags": []
}
```

### Approve with corrections

```bash
curl -X POST http://localhost:3000/api/v1/review/abc-123-.../approve \
  -H "X-API-Key: local-dev-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "reviewer": "admin@example.com",
    "corrections": { "vendor.english": "Corrected Vendor Name" },
    "notes": "Vendor name was incorrect"
  }'
```

## Pipeline Stages

Each document passes through these stages as an idempotent state machine:

| Stage | Description |
|-------|-------------|
| `INGESTED` | File uploaded, validated, stored |
| `CLASSIFIED` | PDF type detected (scanned/digital, invoice/PO/receipt) |
| `EXTRACTED` | Text/OCR extraction with bounding boxes |
| `NORMALIZED` | Japanese text normalized (dates, numbers, characters) |
| `TRANSLATED` | Glossary + AI fallback translation |
| `VALIDATED` | Schema validation + totals reconciliation |
| `QUALITY_CHECKED` | Auto-accept / needs-review / reject decision |
| `EXPOSED` | Ready for frontend consumption |

## Project Structure

```
src/
├── main.ts                           # Bootstrap + Swagger
├── app.module.ts                     # Root module
├── config/configuration.ts           # Env config + Zod validation
├── common/
│   ├── schemas/                      # Canonical + Frontend Zod schemas
│   ├── guards/api-key.guard.ts       # API key auth
│   ├── filters/                      # Global exception filter
│   ├── interceptors/                 # Audit log interceptor
│   └── utils/                        # Hash utilities
├── modules/
│   ├── ingestion/                    # Upload + validation + virus scan
│   ├── classifier/                   # PDF type + language detection
│   ├── extraction/                   # PDF text + OCR + table detection
│   ├── normalization/                # Character/date/number/unit/vendor
│   ├── translation/                  # Glossary + AI fallback
│   ├── validation/                   # Schema mapper + quality gate
│   ├── documents/                    # REST API layer
│   ├── review/                       # Human review workflow
│   ├── orchestrator/                 # State machine + BullMQ processor
│   ├── storage/                      # Local FS adapter (S3-ready)
│   └── health/                       # Health check
├── database/
│   ├── prisma/schema.prisma          # Full DB schema
│   └── seed/                         # Glossary seeder
dictionaries/
└── glossary-seed.json                # Translation dictionary seed data
```

## Configuration

All settings are in `.env` (copy from `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `API_KEY` | — | Required API authentication key |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_HOST` | `localhost` | Redis host for BullMQ |
| `STORAGE_DIR` | `./storage` | Raw PDF storage directory |
| `MAX_FILE_SIZE_MB` | `20` | Max upload size |
| `TESSERACT_LANG` | `jpn` | OCR language |
| `MIN_OCR_CONFIDENCE` | `0.6` | Minimum OCR confidence threshold |
| `AI_PROVIDER` | `none` | `none`, `openai`, or `anthropic` |

## Key Design Decisions

1. **Deterministic-first translation** — Glossary lookup before any AI, with locked entries that AI cannot override.
2. **Immutable raw storage** — Original PDFs are never modified; all transformations are layered.
3. **Full provenance** — Every extracted field tracks its source page, bounding box, raw text, and extraction method.
4. **Confidence scoring** — Numeric confidence on every field, with quality gate thresholds for auto-accept vs review.
5. **Human feedback loop** — Corrections during review automatically update the glossary for future documents.
6. **Idempotent state machine** — Pipeline can be retried from any stage without data corruption.

## Security

- MIME type + magic byte validation (rejects non-PDFs)
- ClamAV virus scanning (optional, graceful degradation if not installed)
- API key authentication on all endpoints
- Tenant isolation via `X-Tenant-Id` header
- No raw files served without auth
- LLM prompts use schema-only output (no prompt injection from document content)

## License

UNLICENSED — Private project.
