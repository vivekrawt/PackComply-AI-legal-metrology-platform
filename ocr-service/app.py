"""
PackComply OCR sidecar - FastAPI + PaddleOCR + OpenCV/Pillow.

The Node server owns the case file, the evidence store and the audit trail; this
service owns pixels and text and nothing else. It is deliberately stateless: it
never writes to disk, never keeps an image after the response, and has no
database. Evidence still lives in exactly one place.

    GET  /health      readiness and the exact model version in use
    POST /preprocess  OpenCV/Pillow preparation only, returns the processed image
    POST /ocr         preparation + PaddleOCR, returns text, boxes and the image

/ocr returns the processed image alongside the text on purpose. The caller stores
it as a derivative of the original, so a report can show the pixels the
recogniser actually read - not a re-run that might differ.

Box coordinates come back as fractions of the ORIGINAL (EXIF-corrected) image, so
callers overlay them on the officer's photograph without knowing that anything
was rotated or cropped.
"""
from __future__ import annotations

import base64
import hashlib
import os
import time
from typing import Any

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

import preprocess
from ocr_engine import get_engine, lang_of, script_of

MAX_UPLOAD_BYTES = int(os.environ.get("PADDLE_MAX_UPLOAD_BYTES", 26_214_400))

app = FastAPI(
    title="PackComply OCR service",
    version="1.0.0",
    description="PaddleOCR + OpenCV/Pillow preprocessing for the PackComply evidence pipeline.",
)


@app.on_event("startup")
def _startup() -> None:
    """
    Build the models at boot when asked.

    Off by default so `uvicorn --reload` stays usable during development; on in
    the container, where a cold first scan is the one that matters.
    """
    if os.environ.get("PADDLE_WARMUP", "").lower() in ("1", "true", "yes"):
        get_engine().warmup()


def _read_upload(file: UploadFile) -> bytes:
    data = file.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"image is {len(data)} bytes, limit is {MAX_UPLOAD_BYTES}",
        )
    return data


def _prepare(data: bytes, deskew: bool, crop: bool, enhance: bool) -> preprocess.Prepared:
    try:
        return preprocess.prepare(data, deskew=deskew, crop=crop, enhance=enhance)
    except HTTPException:
        raise
    except Exception as err:  # decode failures are the caller's problem to fix
        raise HTTPException(status_code=400, detail=f"could not decode image: {err}") from err


def _encoded_image(image: np.ndarray) -> dict[str, Any]:
    png = preprocess.encode_png(image)
    return {
        "mime": "image/png",
        "bytes": len(png),
        "sha256": hashlib.sha256(png).hexdigest(),
        "base64": base64.b64encode(png).decode("ascii"),
    }


@app.get("/health")
def health() -> dict[str, Any]:
    engine = get_engine()
    import cv2
    import PIL

    return {
        "status": "ok",
        "engine": {
            "provider": "paddleocr",
            "modelVersion": engine.model_version,
            "langs": engine.langs,
            # False simply means no image has been processed yet: the models load
            # on first use unless PADDLE_WARMUP built them at boot.
            "ready": engine.ready,
        },
        "versions": {"opencv": cv2.__version__, "pillow": PIL.__version__},
        "maxUploadBytes": MAX_UPLOAD_BYTES,
    }


@app.post("/preprocess")
def preprocess_only(
    image: UploadFile = File(...),
    deskew: bool = Form(True),
    crop: bool = Form(True),
    enhance: bool = Form(True),
) -> JSONResponse:
    """Image preparation with no OCR - useful for tuning and for eyeballing a capture."""
    started = time.perf_counter()
    prepared = _prepare(_read_upload(image), deskew, crop, enhance)
    return JSONResponse(
        {
            "preprocessing": {
                "ops": prepared.ops,
                "inputSize": {"w": prepared.input_size[0], "h": prepared.input_size[1]},
                "outputSize": {"w": prepared.output_size[0], "h": prepared.output_size[1]},
            },
            "processedImage": _encoded_image(prepared.image),
            "timings": {"totalMs": round((time.perf_counter() - started) * 1000)},
        }
    )


@app.post("/ocr")
def ocr(
    image: UploadFile = File(...),
    deskew: bool = Form(True),
    crop: bool = Form(True),
    enhance: bool = Form(True),
    include_image: bool = Form(True),
) -> JSONResponse:
    started = time.perf_counter()
    data = _read_upload(image)

    prep_started = time.perf_counter()
    prepared = _prepare(data, deskew, crop, enhance)
    prep_ms = round((time.perf_counter() - prep_started) * 1000)

    engine = get_engine()
    try:
        lines, timings = engine.recognise(prepared.image)
    except Exception as err:
        # A model that will not load or run is an operational fault, not bad
        # input: say so with a 5xx so the caller retries rather than discarding.
        raise HTTPException(status_code=503, detail=f"OCR engine failed: {err}") from err

    width, height = prepared.input_size
    blocks: list[dict[str, Any]] = []
    for order, line in enumerate(lines):
        # Back to the officer's photograph. A rotated quad has no axis-aligned
        # equivalent, so we take its envelope - slightly generous on skewed text,
        # which is the safe direction for a highlight box.
        pts = prepared.to_input_coords(line.quad)
        x0, y0 = float(pts[:, 0].min()), float(pts[:, 1].min())
        x1, y1 = float(pts[:, 0].max()), float(pts[:, 1].max())
        script = script_of(line.text)
        blocks.append(
            {
                "text": line.text,
                "bbox": {
                    "x": _clamp01(x0 / width),
                    "y": _clamp01(y0 / height),
                    "w": _clamp01((x1 - x0) / width),
                    "h": _clamp01((y1 - y0) / height),
                },
                "readingOrder": order,
                "script": script,
                "lang": lang_of(script),
                "confidence": round(line.confidence, 4),
                "recognisedBy": line.lang,
            }
        )

    payload: dict[str, Any] = {
        "provider": "paddleocr",
        "modelVersion": engine.model_version,
        "blocks": blocks,
        "preprocessing": {
            "ops": prepared.ops,
            "inputSize": {"w": width, "h": height},
            "outputSize": {"w": prepared.output_size[0], "h": prepared.output_size[1]},
        },
        "timings": {**timings, "preprocessMs": prep_ms,
                    "totalMs": round((time.perf_counter() - started) * 1000)},
    }
    if include_image:
        payload["processedImage"] = _encoded_image(prepared.image)
    return JSONResponse(payload)


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, round(value, 4)))
