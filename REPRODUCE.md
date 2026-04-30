# Reproducible Local Execution Setup

This repository has been hardened and simplified into a deterministic, purchase-only extraction service.

## Prerequisites

- **Node.js**: v18+ 
- **Docker**: For Postgres and Redis (optional but recommended for full stack)
- **System Dependencies**: `poppler-utils` (for `pdftoppm` used in OCR)

## Quick Start (No DB required for basic parsing)

If you just want to test the extraction logic on a PDF:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the CLI parser:
   ```bash
   npm run parse path/to/document.pdf
   ```
   *Note: This will still attempt to create a DB record if Postgres is running, but the extraction logic runs independently.*

## Full Setup (Production-like)

1. Start infrastructure:
   ```bash
   docker-compose up -d
   ```

2. Initialize Database:
   ```bash
   npm run prisma:generate
   npm run prisma:push
   ```

3. Start the API server:
   ```bash
   npm run start:dev
   ```

## Regression Testing

To run the full accuracy evaluation against the dataset:
```bash
npm run evaluate
```

## Architecture Summary

- **Entrypoint**: `OrchestratorService` runs a linear `Classify → Extract → Validate` flow.
- **Engine**: `AuctionSheetProcessor` uses regex-based segmentation and parsing (deterministic).
- **Schema**: Outputs strict `PurchaseRecord[]` JSON.
- **Audit**: Every step is logged in the `AuditLog` table.
