"""ChromaDB long-term memory layer for daily reflection + RAG.

Connects to the Dockerized ChromaDB container (port 8001 host -> 8000 container).
Used by `reflection_desk` to persist daily critiques and by future endpoints for RAG lookup.
"""

import os
import uuid
import logging
import chromadb

log = logging.getLogger(__name__)

CHROMA_HOST = os.getenv("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.getenv("CHROMA_PORT", "8001"))

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
    return _client


def _get_collection(name: str = "hedgefund_memory"):
    return _get_client().get_or_create_collection(name=name)


def store_memory(text_content: str, metadata: dict | None = None, collection: str = "hedgefund_memory") -> str | None:
    """Persist a piece of text (reflection, lesson, playbook rule) into ChromaDB. Returns the doc id or None on failure."""
    try:
        col = _get_collection(collection)
        doc_id = str(uuid.uuid4())
        col.add(
            documents=[text_content],
            metadatas=[metadata or {}],
            ids=[doc_id],
        )
        return doc_id
    except Exception as e:
        log.error("ai_memory.store_memory failed: %s", e)
        return None


def query_memory(query_text: str, n_results: int = 3, collection: str = "hedgefund_memory") -> list[str]:
    """Retrieve similar past memories. Returns list of document strings (may be empty on failure)."""
    try:
        col = _get_collection(collection)
        results = col.query(query_texts=[query_text], n_results=n_results)
        docs = results.get("documents") or []
        return docs[0] if docs else []
    except Exception as e:
        log.error("ai_memory.query_memory failed: %s", e)
        return []
