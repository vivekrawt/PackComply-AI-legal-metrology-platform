# PackComply OCR service

PaddleOCR + OpenCV/Pillow, behind a small FastAPI app. The Node server calls it
over loopback; it is the OCR engine for the evidence pipeline
(`PROVIDER_OCR=paddle`).

It is deliberately narrow. It owns pixels and text and nothing else: no
database, no disk writes, no evidence retained after a response. Everything that
has to be kept — the original capture, the prepared image, the recognised text,
the audit trail — is stored by the Node server.

## Why a separate process

PaddleOCR, OpenCV and Pillow are Python; the rest of PackComply is Node. The
alternative to a sidecar is spawning an interpreter per image, which reloads the
models every time (several seconds each). Here they load once and stay warm.

## Setup

From the repo root:

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r ocr-service/requirements.txt   # Windows
.venv/bin/python -m pip install -r ocr-service/requirements.txt       # macOS/Linux
npm run ocr                                                           # starts it on :8100
```

`npm run dev` starts it alongside the API and the web app. A missing venv is not
fatal there — the API still runs, and evidence processing fails loudly with the
setup instructions rather than silently switching engines.

The models (~100 MB) download on first use and are cached under the platform's
Paddle home (`~/.paddlex`). The Docker image bakes them in at build time instead,
so a container never pays for that and works air-gapped.

## Windows note

Install into a venv at a short path. PaddleOCR's C++ headers nest deeply enough
that a long interpreter prefix — a Microsoft Store Python lives under
`AppData\Local\Packages\PythonSoftwareFoundation...` — pushes file paths past the
260-character limit, and pip fails midway leaving an unimportable `paddle`.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Readiness plus the exact model version in use. |
| `POST /preprocess` | Image preparation only; returns the processed image. Useful for tuning. |
| `POST /ocr` | Preparation + recognition; returns text, boxes and the processed image. |

```bash
curl -F "image=@label.jpg" http://127.0.0.1:8100/ocr | jq '.blocks[].text'
```

Boxes come back as fractions of the **original** image, not the processed one.
Preprocessing rotates and crops, so the two coordinate spaces differ; the service
maps every box back through the inverse of its own transform. Callers overlay
boxes on the officer's photograph without knowing preprocessing happened.

`/ocr` returns the processed image so the caller can store it as a derivative of
the original. That is what lets a report show the pixels the recogniser actually
read, rather than a re-run that might differ.

## Preparation pipeline

Ordered, and every step recorded in the response's `preprocessing.ops`:

1. **EXIF transpose** — honour the phone's orientation tag.
2. **Resize down** past `MAX_SIDE` (2560 px) — bounds latency.
3. **Deskew** — median tilt of the text lines, corrected within 0.4°–20°.
4. **Crop** — to the union of *all* text plus a 4% margin, so it can only ever
   remove background, never a declaration.
5. **Resize up** to `MIN_SIDE` (1024 px), capped at 3×.
6. **Enhance** — CLAHE on L in LAB, bilateral denoise, unsharp mask.

Each of `deskew`, `crop` and `enhance` can be switched off per request (form
fields), or globally from the server via `PADDLE_DESKEW` / `PADDLE_CROP` /
`PADDLE_ENHANCE`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PADDLE_LANGS` | `en,devanagari` | Recognisers to run. One pass each, merged by box. |
| `PADDLE_WARMUP` | unset | Load models at boot instead of on first use. |
| `PADDLE_MAX_UPLOAD_BYTES` | 26214400 | Upload cap. |

Language models are per-script, so English and Hindi are two different
recognisers. Both run and their readings are merged: where they overlap, the more
confident wins, except that a reading actually containing Devanagari beats a
Latin model's transliteration of the same box.

## Tests

```bash
../.venv/Scripts/python -m pytest test_preprocess.py
```

Covers the preparation stage only — offline, no models, about a second. The
substantive cases are that a tilted label comes out level, that OCR boxes map
back to the original photograph after rotation and cropping, and that the crop
never drops a line of text.
