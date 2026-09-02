#!/usr/bin/env python3
"""A small HTTP front on WhisperX, for a KithMoot agent that listens.

POST /transcribe   body: a 16-bit mono WAV      -> {"text": ..., "language": ..., "segments": [...]}
GET  /health                                     -> {"ok": true, "model": ...}

Loads the model once and keeps it. Loopback only by default, because what
arrives here is the audio of a room whose people agreed to be transcribed,
and it should go to a model on this machine and nowhere else.

    pip install whisperx
    python3 server/whisperx/server.py

Environment:
    WHISPERX_MODEL          large-v3 (default), large-v2, medium, small, ...
    WHISPERX_DEVICE         cuda | cpu (default: cuda if available, else cpu)
    WHISPERX_COMPUTE_TYPE   float16 on cuda, int8 on cpu, by default
    WHISPERX_LANGUAGE       force a language for every request (a request's
                            ?language= overrides)
    WHISPERX_ALIGN          1 to run the alignment pass for word timings
                            (slower; off by default - a transcript for an
                            agent to read needs sentences, not timestamps)
    WHISPERX_HOST           127.0.0.1
    WHISPERX_PORT           8765
"""

import io
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


def env(name, default=None):
    value = os.environ.get(name)
    return value if value not in (None, "") else default


MODEL_NAME = env("WHISPERX_MODEL", "large-v3")
FORCED_LANGUAGE = env("WHISPERX_LANGUAGE")
ALIGN = env("WHISPERX_ALIGN", "0") == "1"
HOST = env("WHISPERX_HOST", "127.0.0.1")
PORT = int(env("WHISPERX_PORT", "8765"))


class Engine:
    """WhisperX, loaded once, called under a lock: the model is not
    re-entrant and an agent may have several people talking at once."""

    def __init__(self):
        import torch  # noqa: F401  (whisperx pulls it in; fail early if absent)
        import whisperx

        self.whisperx = whisperx
        self.device = env("WHISPERX_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
        self.compute_type = env("WHISPERX_COMPUTE_TYPE") or ("float16" if self.device == "cuda" else "int8")
        self.model = whisperx.load_model(
            MODEL_NAME, self.device, compute_type=self.compute_type, language=FORCED_LANGUAGE
        )
        self.lock = threading.Lock()
        self.aligners = {}

    def transcribe(self, wav_bytes, language):
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as f:
            f.write(wav_bytes)
            f.flush()
            audio = self.whisperx.load_audio(f.name)
        with self.lock:
            result = self.model.transcribe(audio, batch_size=8, language=language)
            detected = result.get("language") or language
            if ALIGN and detected:
                aligner = self.aligners.get(detected)
                if aligner is None:
                    aligner = self.whisperx.load_align_model(language_code=detected, device=self.device)
                    self.aligners[detected] = aligner
                model_a, metadata = aligner
                result = self.whisperx.align(
                    result["segments"], model_a, metadata, audio, self.device, return_char_alignments=False
                )
                result["language"] = detected
        segments = result.get("segments", [])
        text = " ".join(s.get("text", "").strip() for s in segments).strip()
        return {"text": text, "language": detected, "segments": segments}


class Handler(BaseHTTPRequestHandler):
    engine = None

    def _json(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            return self._json(200, {"ok": True, "model": MODEL_NAME, "device": self.engine.device})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("content-length", "0"))
        if length <= 44:
            return self._json(400, {"error": "expected a WAV body"})
        wav = self.rfile.read(length)
        language = parse_qs(url.query).get("language", [FORCED_LANGUAGE])[0]
        try:
            return self._json(200, self.engine.transcribe(wav, language))
        except Exception as e:  # noqa: BLE001 - anything the model throws is a 500 with the reason
            return self._json(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    print(f"loading whisperx {MODEL_NAME}...", file=sys.stderr)
    Handler.engine = Engine()
    print(f"whisperx {MODEL_NAME} on {Handler.engine.device} ({Handler.engine.compute_type})", file=sys.stderr)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"listening on http://{HOST}:{PORT}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
