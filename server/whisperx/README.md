# WhisperX for a listening agent

`server.py` is a small HTTP front on [WhisperX](https://github.com/m-bain/whisperX):
one model, loaded once, answering `POST /transcribe` with the text of a WAV.
A KithMoot agent that listens (`kithmoot-agent ... --listen`) sends each
utterance it hears to this and writes the answer into the room's
`transcript` channel.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install whisperx
python3 server/whisperx/server.py         # loads large-v3, listens on 127.0.0.1:8765
curl -s localhost:8765/health
```

Loopback only by default. What arrives here is the audio of a room whose
people agreed to be transcribed; it should go to a model on this machine and
nowhere else. Set `WHISPERX_HOST` to something else only if you have thought
about where that audio then goes.

| Variable | Default | |
|---|---|---|
| `WHISPERX_MODEL` | `large-v3` | Any faster-whisper model name. `large-v3` is the quality the agent wants; `small` runs on a laptop CPU in near real time. |
| `WHISPERX_DEVICE` | `cuda` if present, else `cpu` | Apple Silicon is `cpu`: CTranslate2 has no Metal backend. |
| `WHISPERX_COMPUTE_TYPE` | `float16` on cuda, `int8` on cpu | |
| `WHISPERX_LANGUAGE` | detect | A room that knows what it speaks should say so: detection is per utterance and short utterances detect badly. A request's `?language=` overrides. |
| `WHISPERX_ALIGN` | `0` | `1` runs the alignment pass for word timings. Slower, and an agent reading a transcript needs sentences, not timestamps. |
| `WHISPERX_PORT` | `8765` | |

The request is a 16-bit mono WAV at 16 kHz, which is what `wavFromPcm` in
`src/node/utterances.ts` writes. The answer is
`{"text": "...", "language": "en", "segments": [...]}`; an empty `text` is
"nothing said" and the agent writes no transcript for it.
