from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .transcriber import WhisperTranscriber


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"

DEFAULT_SYSTEM_PROMPT = """Clean this transcript into polished writing without changing the speaker's meaning.

- Detect and fix possible transcription mistakes by context.
- Remove filler words and redundant repetitions when they do not affect meaning.
- Preserve the speaker's voice, wording, and first-person perspective.
- Keep names, technical terms, numbers, and intent intact.
- Return only the cleaned transcript.
- Do not include an introduction, heading, markdown, notes, explanations, or a list of changes.
- Do not say what you removed or changed."""


class CleanRequest(BaseModel):
    text: str = Field(min_length=1)
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    system_prompt: str = DEFAULT_SYSTEM_PROMPT


class CleanResponse(BaseModel):
    cleaned_text: str


class ModelsResponse(BaseModel):
    models: list[str]


class TranscribeResponse(BaseModel):
    text: str


app = FastAPI(title="Transcribe Me")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

transcriber = WhisperTranscriber()


def default_llm_base_url() -> str:
    return os.getenv("LLM_BASE_URL", "http://localhost:11434/v1")


def default_llm_model() -> str:
    return os.getenv("LLM_MODEL", "llama3.2:3b")


def default_llm_max_tokens() -> int:
    return int(os.getenv("LLM_MAX_TOKENS", "2048"))


def chat_completions_url(base_url: str) -> str:
    clean_url = base_url.rstrip("/")
    if clean_url.endswith("/chat/completions"):
        return clean_url
    return f"{clean_url}/chat/completions"


def models_url(base_url: str) -> str:
    clean_url = base_url.rstrip("/")
    if clean_url.endswith("/chat/completions"):
        clean_url = clean_url[: -len("/chat/completions")]
    return f"{clean_url}/models"


def ollama_root_url(base_url: str) -> str:
    clean_url = base_url.rstrip("/")
    if clean_url.endswith("/chat/completions"):
        clean_url = clean_url[: -len("/chat/completions")]
    if clean_url.endswith("/v1"):
        clean_url = clean_url[: -len("/v1")]
    return clean_url


def is_probably_ollama_url(base_url: str) -> bool:
    parsed = urlparse(base_url)
    host = parsed.hostname or ""
    return parsed.port == 11434 or "ollama" in host.lower()


async def available_llm_models(base_url: str, api_key: str | None = None) -> list[str]:
    headers: dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    model_names: set[str] = set()

    async with httpx.AsyncClient(timeout=10) as client:
        try:
            response = await client.get(models_url(base_url), headers=headers)
            response.raise_for_status()
            data = response.json()
            for model in data.get("data", []):
                model_id = model.get("id")
                if model_id:
                    model_names.add(model_id)
        except httpx.HTTPError:
            pass

        try:
            response = await client.get(f"{ollama_root_url(base_url)}/api/tags")
            response.raise_for_status()
            data = response.json()
            for model in data.get("models", []):
                model_name = model.get("name")
                if model_name:
                    model_names.add(model_name)
        except httpx.HTTPError:
            pass

    return sorted(model_names, key=str.lower)


def extract_llm_error(response: httpx.Response, fallback: str) -> str:
    try:
        payload = response.json()
    except ValueError:
        return response.text[:1000] or fallback

    error = payload.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if message:
            return str(message)

    detail = payload.get("detail")
    if detail:
        return str(detail)

    return response.text[:1000] or fallback


def cleanup_messages(system_prompt: str, text: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": text},
    ]


async def model_not_found_detail(base_url: str, model_error: str, api_key: str | None = None) -> str:
    models = await available_llm_models(base_url, api_key)
    available = ", ".join(models) if models else "none detected"
    return (
        f"{model_error}. Installed models visible from this app: {available}. "
        "Pull a cleanup model with `ollama pull llama3.2:3b`, then set the model to "
        "`llama3.2:3b` in settings, or pick one of the detected models."
    )


async def clean_with_ollama_native(
    base_url: str,
    model: str,
    system_prompt: str,
    text: str,
) -> str:
    endpoint = f"{ollama_root_url(base_url)}/api/chat"
    payload: dict[str, Any] = {
        "model": model,
        "messages": cleanup_messages(system_prompt, text),
        "stream": False,
        "think": False,
        "options": {
            "temperature": 0.1,
            "num_predict": default_llm_max_tokens(),
        },
    }

    try:
        async with httpx.AsyncClient(timeout=180) as client:
            response = await client.post(endpoint, json=payload)
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = extract_llm_error(exc.response, exc.response.reason_phrase)
        if "not found" in detail.lower() and "model" in detail.lower():
            detail = await model_not_found_detail(base_url, detail)
        raise HTTPException(status_code=502, detail=detail) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    data = response.json()
    message = data.get("message", {})
    cleaned_text = message.get("content", "").strip() if isinstance(message, dict) else ""
    if not cleaned_text:
        raise HTTPException(
            status_code=502,
            detail=(
                "The LLM returned an empty cleanup result. Pick an instruction/chat model that "
                "returns final message content, such as `llama3.2:3b` or `qwen2.5:7b-instruct`."
            ),
        )

    return cleaned_text


def suffix_for_upload(content_type: str | None, filename: str | None) -> str:
    probe = f"{content_type or ''} {filename or ''}".lower()
    if "ogg" in probe or ".ogg" in probe:
        return ".ogg"
    if "mp4" in probe or "mpeg" in probe or ".m4a" in probe:
        return ".mp4"
    if "wav" in probe:
        return ".wav"
    if "mp3" in probe:
        return ".mp3"
    return ".webm"


def is_likely_silence_hallucination(text: str) -> bool:
    normalized = re.sub(r"[^a-z]+", " ", text.lower()).strip()
    if not normalized:
        return False

    words = normalized.split()
    if set(words) == {"you"} and len(words) <= 4:
        return True

    return normalized in {
        "thank you",
        "thanks for watching",
        "bye",
    }


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/settings")
async def settings() -> dict[str, str]:
    return {
        "whisper_model": transcriber.model_name,
        "llm_base_url": default_llm_base_url(),
        "llm_model": default_llm_model(),
        "system_prompt": DEFAULT_SYSTEM_PROMPT,
    }


@app.get("/api/llm-models", response_model=ModelsResponse)
async def llm_models(
    base_url: str | None = Query(default=None),
    api_key: str | None = Query(default=None),
) -> ModelsResponse:
    models = await available_llm_models(base_url or default_llm_base_url(), api_key)
    return ModelsResponse(models=models)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(file: UploadFile = File(...)) -> TranscribeResponse:
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=400, detail="No audio was uploaded")

    suffix = suffix_for_upload(file.content_type, file.filename)
    try:
        text = await asyncio.to_thread(transcriber.transcribe_bytes, audio, suffix)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if is_likely_silence_hallucination(text):
        text = ""

    return TranscribeResponse(text=text)


@app.post("/api/clean", response_model=CleanResponse)
async def clean_transcript(request: CleanRequest) -> CleanResponse:
    base_url = request.base_url or default_llm_base_url()
    model = request.model or default_llm_model()

    if is_probably_ollama_url(base_url):
        cleaned_text = await clean_with_ollama_native(
            base_url,
            model,
            request.system_prompt,
            request.text,
        )
        return CleanResponse(cleaned_text=cleaned_text)

    endpoint = chat_completions_url(base_url)

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if request.api_key:
        headers["Authorization"] = f"Bearer {request.api_key}"

    payload: dict[str, Any] = {
        "model": model,
        "messages": cleanup_messages(request.system_prompt, request.text),
        "temperature": 0.1,
        "max_tokens": default_llm_max_tokens(),
        "stream": False,
    }

    try:
        async with httpx.AsyncClient(timeout=180) as client:
            response = await client.post(endpoint, headers=headers, json=payload)
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = extract_llm_error(exc.response, exc.response.reason_phrase)
        if "not found" in detail.lower() and "model" in detail.lower():
            detail = await model_not_found_detail(base_url, detail, request.api_key)
        raise HTTPException(status_code=502, detail=detail) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    data = response.json()
    try:
        message = data["choices"][0]["message"]
        content = message.get("content", "") if isinstance(message, dict) else ""
        cleaned_text = content.strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="Unexpected LLM response shape") from exc

    if not cleaned_text:
        reasoning = message.get("reasoning") if isinstance(message, dict) else None
        detail = (
            "The LLM returned an empty cleanup result. Use an instruction/chat model that returns "
            "final message content, such as `llama3.2:3b` or `qwen2.5:7b-instruct`."
        )
        if reasoning:
            detail += " This model appears to be returning reasoning only through the chat endpoint."
        raise HTTPException(status_code=502, detail=detail)

    return CleanResponse(cleaned_text=cleaned_text)
