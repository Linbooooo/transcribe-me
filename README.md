# Transcribe Me

A small full-stack transcription tool with a one-page browser UI, FastAPI backend, local Whisper transcription after recording, and LLM cleanup through an OpenAI-compatible chat endpoint.

## Run With Docker

```bash
docker compose up --build
```

Open [http://localhost:8000](http://localhost:8000).

The first transcription request downloads the configured Whisper model into the `whisper-cache` Docker volume. The default cleanup endpoint targets Ollama on the host machine:

```bash
ollama pull llama3.2:3b
ollama serve
```

You can also use any OpenAI-compatible chat completions endpoint from the UI by changing the model, URL, and API key fields. The settings panel lists models visible from the configured endpoint when the provider supports model listing. For Ollama on port `11434`, cleanup uses Ollama's native chat API with thinking disabled so Qwen-style reasoning models return final text.

## Configuration

Environment variables:

| Name | Default | Notes |
| --- | --- | --- |
| `WHISPER_MODEL` | `base.en` | Faster-Whisper model name or local model path |
| `WHISPER_DEVICE` | `cpu` | Use `cuda` when your Docker setup exposes a GPU |
| `WHISPER_COMPUTE_TYPE` | `int8` | Good CPU default; use `float16` for many GPU setups |
| `WHISPER_LANGUAGE` | unset | Optional language code such as `en` |
| `WHISPER_VAD_FILTER` | `false` | Optional Faster-Whisper VAD filtering |
| `WHISPER_NO_SPEECH_THRESHOLD` | `0.6` | Whisper no-speech cutoff; lower is stricter |
| `LLM_BASE_URL` | `http://host.docker.internal:11434/v1` in Docker | OpenAI-compatible base URL |
| `LLM_MODEL` | `llama3.2:3b` | Cleanup model name |
| `LLM_MAX_TOKENS` | `2048` | Maximum cleanup response length |
| `APP_PORT` | `8000` | Host port used by Docker Compose |

## Cleanup Model Choice

For local cleanup, start with `llama3.2:3b`. It is small enough to run quickly on many machines and is instruction-tuned for rewriting, summarization, and dialogue-style prompts. If you want stronger cleanup and can spare more RAM and latency, `qwen2.5:7b-instruct` is a good upgrade because it follows prompts well and handles longer text. Avoid thinking/reasoning variants that return only reasoning metadata through the OpenAI-compatible endpoint; the app needs final message content.

## Run Locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open [http://localhost:8000](http://localhost:8000).
