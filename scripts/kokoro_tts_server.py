#!/usr/bin/env python3
"""Minimal local OpenAI-compatible TTS server backed by Kokoro (ONNX).

POST /v1/audio/speech {"input": "...", "voice": "af_heart", "response_format": "wav"}
GET  /v1/models

Setup:
  py -3 -m venv .venv-tts && .venv-tts/Scripts/python -m pip install kokoro-onnx soundfile
  download kokoro-v1.0.onnx and voices-v1.0.bin into models/kokoro/
Run:
  .venv-tts/Scripts/python scripts/kokoro_tts_server.py --port 8880
"""
import argparse
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

import soundfile as sf
from kokoro_onnx import Kokoro

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8880)
    parser.add_argument("--model", default=str(ROOT / "models/kokoro/kokoro-v1.0.onnx"))
    parser.add_argument("--voices", default=str(ROOT / "models/kokoro/voices-v1.0.bin"))
    args = parser.parse_args()
    kokoro = Kokoro(args.model, args.voices)
    lock = Lock()
    voices = sorted(kokoro.get_voices())

    class Handler(BaseHTTPRequestHandler):
        def _json(self, code, payload):
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.rstrip("/") in ("/v1/models", "/models"):
                return self._json(200, {"data": [{"id": "kokoro"}], "voices": voices})
            self._json(404, {"error": "not found"})

        def do_POST(self):
            if self.path.rstrip("/") not in ("/v1/audio/speech", "/audio/speech"):
                return self._json(404, {"error": "not found"})
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                text = str(req.get("input", "")).strip()
                voice = req.get("voice") or "af_heart"
                if not text:
                    return self._json(400, {"error": "input is required"})
                if voice not in voices:
                    return self._json(400, {"error": f"unknown voice {voice}"})
                with lock:
                    samples, rate = kokoro.create(text, voice=voice, speed=float(req.get("speed", 1.0)), lang="en-us")
                buf = io.BytesIO()
                sf.write(buf, samples, rate, format="WAV")
                body = buf.getvalue()
                self.send_response(200)
                self.send_header("content-type", "audio/wav")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as error:  # noqa: BLE001
                self._json(500, {"error": str(error)})

        def log_message(self, *_):
            pass

    print(f"Kokoro TTS on http://{args.host}:{args.port}/v1 ({len(voices)} voices)", flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
