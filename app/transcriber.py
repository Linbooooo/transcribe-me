from __future__ import annotations

import os
import sys
import tempfile
import threading
from pathlib import Path


class WhisperTranscriber:
    """Lazy wrapper around a local Whisper-compatible model."""

    def __init__(self) -> None:
        self.model_name = os.getenv("WHISPER_MODEL", "base.en")
        self.device = os.getenv("WHISPER_DEVICE", "cpu")
        self.compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
        self.language = os.getenv("WHISPER_LANGUAGE") or None
        self.vad_filter = os.getenv("WHISPER_VAD_FILTER", "false").lower() == "true"
        self.no_speech_threshold = float(os.getenv("WHISPER_NO_SPEECH_THRESHOLD", "0.6"))
        self._model = None
        self._lock = threading.Lock()

    def _load_model(self):
        if self._model is None:
            from faster_whisper import WhisperModel

            self._model = WhisperModel(
                self.model_name,
                device=self.device,
                compute_type=self.compute_type,
            )
        return self._model

    def transcribe_bytes(self, audio: bytes, suffix: str = ".webm") -> str:
        if not audio:
            return ""

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_file.write(audio)
            temp_path = Path(temp_file.name)

        try:
            with self._lock:
                model = self._load_model()
                segments, _info = model.transcribe(
                    str(temp_path),
                    beam_size=1,
                    vad_filter=self.vad_filter,
                    language=self.language,
                    condition_on_previous_text=False,
                    no_speech_threshold=self.no_speech_threshold,
                )
                return " ".join(segment.text.strip() for segment in segments).strip()
        finally:
            temp_path.unlink(missing_ok=True)


if __name__ == "__main__":
    audio_path = Path(sys.argv[1])
    print(WhisperTranscriber().transcribe_bytes(audio_path.read_bytes(), audio_path.suffix))
