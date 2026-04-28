"""
Marker Sidecar — FastAPI wrapper around Marker's PdfConverter.

Endpoints:
  POST /convert         — Full PDF → JSON block tree
  POST /convert/tables  — Table-only extraction
  GET  /health          — Liveness check

Designed to be called by the NestJS orchestrator over HTTP.
LLM boost is OFF by default — controlled by the NestJS LlmBudgetManager.
"""

import hashlib
import logging
import os
import tempfile
import time
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

logger = logging.getLogger("marker-sidecar")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="Marker Sidecar", version="1.0.0")

# ── Lazy-loaded models (heavy, load once) ────────────────────────
_model_dict = None
_models_loading = False


def _get_model_dict():
    """Lazy-load Marker models on first request."""
    global _model_dict, _models_loading
    if _model_dict is not None:
        return _model_dict
    if _models_loading:
        raise HTTPException(503, "Models are still loading. Retry in a few seconds.")
    _models_loading = True
    try:
        logger.info("Loading Marker models (first request)...")
        from marker.models import create_model_dict
        _model_dict = create_model_dict()
        logger.info("Marker models loaded successfully.")
        return _model_dict
    except Exception as e:
        _models_loading = False
        logger.error(f"Failed to load Marker models: {e}")
        raise HTTPException(500, f"Model loading failed: {e}")


# ── Health ───────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "models_loaded": _model_dict is not None,
        "engine": "marker-pdf",
        "engine_version": _get_marker_version(),
    }


def _get_marker_version() -> str:
    try:
        import marker
        return getattr(marker, "__version__", "unknown")
    except Exception:
        return "unknown"


# ── Convert (full) ───────────────────────────────────────────────

@app.post("/convert")
async def convert_pdf(
    file: UploadFile = File(...),
    force_ocr: bool = Form(False),
    use_llm: bool = Form(False),
    page_range: Optional[str] = Form(None),
):
    """
    Convert a PDF to Marker's JSON block tree.

    Returns per-page block tree with:
    - block_type, polygon, children, html
    - Table cells with bounding boxes
    - Form detection
    - Metadata (page_stats, text_extraction_method)
    """
    start = time.time()

    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are accepted.")

    content = await file.read()
    if len(content) == 0:
        raise HTTPException(400, "Empty file.")
    if len(content) > 50 * 1024 * 1024:  # 50MB limit
        raise HTTPException(413, "File too large. Maximum 50MB.")

    file_hash = hashlib.sha256(content).hexdigest()

    # Write to temp file (Marker needs a file path)
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        from marker.converters.pdf import PdfConverter
        from marker.config.parser import ConfigParser

        config = {"output_format": "json"}
        if force_ocr:
            config["force_ocr"] = True
        if page_range:
            config["page_range"] = page_range

        config_parser = ConfigParser(config)

        converter_kwargs = {
            "config": config_parser.generate_config_dict(),
            "artifact_dict": _get_model_dict(),
            "processor_list": config_parser.get_processors(),
            "renderer": config_parser.get_renderer(),
        }

        # Only add LLM service if explicitly requested and approved
        if use_llm:
            try:
                converter_kwargs["llm_service"] = config_parser.get_llm_service()
            except Exception as e:
                logger.warning(f"LLM service unavailable: {e}. Proceeding without LLM.")

        converter = PdfConverter(**converter_kwargs)
        rendered = converter(tmp_path)

        elapsed_ms = int((time.time() - start) * 1000)

        # Build response
        result = {
            "file_hash": file_hash,
            "filename": file.filename,
            "engine": "marker-pdf",
            "engine_version": _get_marker_version(),
            "force_ocr": force_ocr,
            "use_llm": use_llm,
            "elapsed_ms": elapsed_ms,
            "pages": [],
            "metadata": {},
        }

        # Extract pages from rendered output
        if hasattr(rendered, "children") and rendered.children is not None:
            # JSON output mode: rendered is a tree
            result["pages"] = _serialize_block_tree(rendered)
        elif hasattr(rendered, "json"):
            result["pages"] = rendered.json
        else:
            # Fallback: try to get whatever is available
            result["pages"] = _try_extract_pages(rendered)

        if hasattr(rendered, "metadata"):
            result["metadata"] = _serialize_metadata(rendered.metadata)

        logger.info(
            f"Converted {file.filename}: {len(result['pages'])} pages in {elapsed_ms}ms"
        )
        return JSONResponse(content=result)

    except Exception as e:
        logger.error(f"Conversion failed for {file.filename}: {e}", exc_info=True)
        raise HTTPException(500, f"Conversion failed: {str(e)}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ── Convert tables only ──────────────────────────────────────────

@app.post("/convert/tables")
async def convert_tables(
    file: UploadFile = File(...),
    force_ocr: bool = Form(False),
    use_llm: bool = Form(False),
):
    """
    Extract only tables from a PDF using Marker's TableConverter.
    Returns table cells with bounding boxes.
    """
    start = time.time()

    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are accepted.")

    content = await file.read()
    if len(content) == 0:
        raise HTTPException(400, "Empty file.")

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        from marker.converters.table import TableConverter
        from marker.config.parser import ConfigParser

        config = {"output_format": "json"}
        if force_ocr:
            config["force_ocr"] = True

        config_parser = ConfigParser(config)

        converter_kwargs = {
            "config": config_parser.generate_config_dict(),
            "artifact_dict": _get_model_dict(),
            "processor_list": config_parser.get_processors(),
            "renderer": config_parser.get_renderer(),
        }

        if use_llm:
            try:
                converter_kwargs["llm_service"] = config_parser.get_llm_service()
            except Exception:
                pass

        converter = TableConverter(**converter_kwargs)
        rendered = converter(tmp_path)

        elapsed_ms = int((time.time() - start) * 1000)

        result = {
            "engine": "marker-pdf-table",
            "elapsed_ms": elapsed_ms,
            "tables": [],
        }

        if hasattr(rendered, "children") and rendered.children is not None:
            result["tables"] = _serialize_block_tree(rendered)
        elif hasattr(rendered, "json"):
            result["tables"] = rendered.json

        return JSONResponse(content=result)

    except Exception as e:
        logger.error(f"Table extraction failed: {e}", exc_info=True)
        raise HTTPException(500, f"Table extraction failed: {str(e)}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ── Serialization helpers ────────────────────────────────────────

def _serialize_block_tree(rendered) -> list:
    """Convert Marker's rendered output to serializable dicts."""
    try:
        if hasattr(rendered, "model_dump"):
            data = rendered.model_dump()
            if isinstance(data, dict) and "children" in data:
                return data.get("children", [])
            return [data] if isinstance(data, dict) else data
        if hasattr(rendered, "dict"):
            data = rendered.dict()
            if isinstance(data, dict) and "children" in data:
                return data.get("children", [])
            return [data] if isinstance(data, dict) else data
        return []
    except Exception as e:
        logger.warning(f"Block tree serialization fallback: {e}")
        return []


def _try_extract_pages(rendered) -> list:
    """Best-effort page extraction from unknown rendered format."""
    try:
        if hasattr(rendered, "model_dump"):
            return [rendered.model_dump()]
        if isinstance(rendered, dict):
            return [rendered]
        if isinstance(rendered, list):
            return rendered
        return [{"raw": str(rendered)}]
    except Exception:
        return []


def _serialize_metadata(metadata) -> dict:
    """Safely serialize metadata."""
    try:
        if hasattr(metadata, "model_dump"):
            return metadata.model_dump()
        if hasattr(metadata, "dict"):
            return metadata.dict()
        if isinstance(metadata, dict):
            return metadata
        return {}
    except Exception:
        return {}


# ── Entry point ──────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("MARKER_PORT", "8001"))
    host = os.environ.get("MARKER_HOST", "0.0.0.0")
    logger.info(f"Starting Marker sidecar on {host}:{port}")
    uvicorn.run(app, host=host, port=port)
