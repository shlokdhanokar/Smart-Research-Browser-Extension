import base64
import logging
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import Session

from app.database import Base, engine, get_db
from app.models import CapturedPage
from app.schemas import PageCapture, PageResult, SearchQuery, SearchResponse, ThumbnailUpdate
from app.services.embeddings import embedder
from app.services.router import query_router
from app.services.search import search_service
from app.utils import clean_content, extract_domain, extract_title_from_content

logger = logging.getLogger(__name__)

# Create tables on startup if the DB user has CREATE on schema public.
# If you get "permission denied for schema public", either:
# - Run as DB superuser: GRANT CREATE ON SCHEMA public TO your_app_user;
# - Or create the table (and enable pgvector) yourself, then restart the app.
try:
    Base.metadata.create_all(bind=engine)
except Exception as e:
    logger.warning("Table create_all failed (tables may already exist or user lacks CREATE): %s", e)

# Verify table exists so search/capture don't fail with a confusing error
try:
    with engine.connect() as conn:
        conn.execute(text("SELECT 1 FROM captured_pages LIMIT 0"))
except ProgrammingError as e:
    msg = str(e.orig) if getattr(e, "orig", None) else str(e)
    if "does not exist" in msg or "UndefinedTable" in msg:
        logger.error(
            "Table 'captured_pages' does not exist. Create it: python -m app.init_db "
            "(use a DB user with CREATE permission, e.g. postgres)."
        )
except Exception:
    pass

try:
    with engine.connect() as conn:
        conn.execute(text("ALTER TABLE captured_pages ADD COLUMN thumbnail BYTEA"))
        conn.commit()
except ProgrammingError as e:
    msg = str(e.orig) if getattr(e, "orig", None) else str(e)
    if "already exists" not in msg.lower():
        logger.warning("Could not add thumbnail column (may already exist): %s", e)
except Exception:
    pass

app = FastAPI(title="HindSite API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(ProgrammingError)
def handle_missing_table(request, exc):
    msg = str(exc.orig) if getattr(exc, "orig", None) else str(exc)
    if "does not exist" in msg or "UndefinedTable" in msg:
        return JSONResponse(
            status_code=503,
            content={
                "detail": "Database table not created. Install pgvector, then run: python -m app.init_db"
            },
        )
    raise exc


@app.get("/health")
def health_check():
    return {"status": "healthy", "message": "HindSite API is running"}


def _decode_thumbnail_b64(raw: Optional[str]):
    if not raw:
        return None
    s = "".join(raw.split())
    try:
        return base64.b64decode(s, validate=True)
    except Exception:
        try:
            return base64.b64decode(s, validate=False)
        except Exception:
            return None


@app.post("/pages/thumbnail")
def update_page_thumbnail(body: ThumbnailUpdate, db: Session = Depends(get_db)):
    """Attach or replace thumbnail for an existing captured page (same URL)."""
    page = db.query(CapturedPage).filter(CapturedPage.url == body.url).first()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found for URL")
    thumb_bytes = _decode_thumbnail_b64(body.thumbnail)
    if not thumb_bytes:
        raise HTTPException(status_code=400, detail="Invalid thumbnail base64")
    page.thumbnail = thumb_bytes
    db.commit()
    return {"status": "updated", "id": page.id}


@app.post("/capture")
def capture_page(page: PageCapture, db: Session = Depends(get_db)):
    """Capture a page with embedding generation."""
    existing = db.query(CapturedPage).filter(CapturedPage.url == page.url).first()
    thumb_bytes = _decode_thumbnail_b64(page.thumbnail)

    if existing:
        if thumb_bytes:
            existing.thumbnail = thumb_bytes
            db.commit()
        return {"status": "exists", "id": existing.id}

    content = clean_content(page.content)

    try:
        embedding = embedder.generate_document_embedding(content)
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Embedding generation failed: {str(e)}"
        )

    db_page = CapturedPage(
        url=page.url,
        title=extract_title_from_content(content, page.url),
        content=content,
        domain=extract_domain(page.url),
        time_spent=page.metadata.get("timeSpent", 0),
        scroll_percent=page.metadata.get("scrollPercent", 0),
        word_count=page.metadata.get("wordCount", 0),
        embedding=embedding,
        thumbnail=thumb_bytes or None,
    )

    db.add(db_page)
    db.commit()
    db.refresh(db_page)

    return {"status": "captured", "id": db_page.id, "title": db_page.title}


@app.post("/search", response_model=SearchResponse)
def search(query: SearchQuery, db: Session = Depends(get_db)):
    """
    Unified search: tab_switch (match open tabs) or semantic_search (vector + rerank).
    """
    intent = query_router.detect_intent(query.query)

    if intent == "tab_switch" and query.open_tabs:
        matched_tab = query_router.find_matching_tab(query.query, query.open_tabs)
        if matched_tab:
            return SearchResponse(
                query_type="tab_switch",
                matched_tab=matched_tab,
                results=None,
            )
        intent = "semantic_search"

    try:
        results = search_service.search_pages(
            query.query, db, limit=query.limit or 3
        )
    except ProgrammingError as e:
        msg = str(e.orig) if getattr(e, "orig", None) else str(e)
        if "does not exist" in msg or "UndefinedTable" in msg:
            logger.exception("Semantic search failed (table missing)")
            raise HTTPException(
                status_code=503,
                detail="Table 'captured_pages' does not exist. Run: python -m app.init_db (use a DB user with CREATE permission, e.g. postgres).",
            )
        raise
    except Exception as e:
        logger.exception("Semantic search failed")
        raise HTTPException(
            status_code=503,
            detail=f"Search failed: {str(e)}. Check COHERE_API_KEY in .env and that the database table exists.",
        )

    return SearchResponse(
        query_type="semantic_search",
        results=results,
        matched_tab=None,
    )


@app.get("/pages")
def list_pages(limit: int = 50, db: Session = Depends(get_db)):
    """List recently captured pages."""
    pages = (
        db.query(CapturedPage)
        .order_by(CapturedPage.captured_at.desc())
        .limit(limit)
        .all()
    )
    return [
        PageResult(
            id=p.id,
            url=p.url,
            title=p.title,
            domain=p.domain or "",
            snippet=(
                (p.content[:150] + "...")
                if p.content and len(p.content) > 150
                else (p.content or "")
            ),
            similarity=1.0,
            time_spent=p.time_spent,
            captured_at=p.captured_at,
            thumbnail_base64=base64.b64encode(p.thumbnail).decode() if p.thumbnail else None,
        )
        for p in pages
    ]


@app.delete("/pages/{page_id}")
def delete_page(page_id: str, db: Session = Depends(get_db)):
    """Delete a captured page."""
    page = db.query(CapturedPage).filter(CapturedPage.id == page_id).first()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    db.delete(page)
    db.commit()
    return {"status": "deleted", "id": page_id}
