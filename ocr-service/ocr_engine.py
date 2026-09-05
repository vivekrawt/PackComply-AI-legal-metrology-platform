"""
PaddleOCR wrapper.

The engine is loaded once and held warm. Construction downloads (first run) and
then initialises the detection, orientation and recognition models, which costs
several seconds - far too much to pay per photograph in a six-face scan.

Language: PaddleOCR's recognition models are per-script. Latin and Devanagari are
different models, so covering an Indian package label - English declarations,
Hindi declarations, very often both on the same face - means running each
configured recogniser over the image and merging. `PADDLE_LANGS` controls which
ones (default "en,devanagari"); a single-language deployment just sets one and
pays for one pass.
"""
from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Any

import numpy as np

DEVANAGARI = re.compile(r"[ऀ-ॿ]")
LATIN = re.compile(r"[A-Za-z]")

# Two boxes overlapping by more than this are taken to be the same line of text
# found by two recognisers; the more confident reading wins.
MERGE_IOU = 0.55


@dataclass
class Line:
    text: str
    quad: np.ndarray  # 4x2, processed-image coordinates
    confidence: float
    lang: str  # which recogniser produced it


def script_of(text: str) -> str:
    """Mirrors the classification the Node providers use, so both agree."""
    dev = bool(DEVANAGARI.search(text))
    lat = bool(LATIN.search(text))
    if dev and lat:
        return "mixed"
    return "devanagari" if dev else "latin"


def lang_of(script: str) -> str:
    return {"devanagari": "hi", "mixed": "mixed"}.get(script, "en")


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    """IoU of the axis-aligned envelopes of two quads. Cheap and good enough."""
    ax0, ay0 = a[:, 0].min(), a[:, 1].min()
    ax1, ay1 = a[:, 0].max(), a[:, 1].max()
    bx0, by0 = b[:, 0].min(), b[:, 1].min()
    bx1, by1 = b[:, 0].max(), b[:, 1].max()
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    union = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter
    return float(inter / union) if union > 0 else 0.0


def reading_order(lines: list[Line]) -> list[Line]:
    """
    Sort roughly the way a person reads a package: top to bottom, left to right
    within a band. The band tolerance is a third of the median line height, so a
    line that sits a few pixels higher than its neighbour is not treated as a
    row of its own.
    """
    if not lines:
        return []
    heights = [float(line.quad[:, 1].max() - line.quad[:, 1].min()) for line in lines]
    band = max(1.0, float(np.median(heights)) / 3.0)
    return sorted(
        lines,
        key=lambda line: (round(float(line.quad[:, 1].min()) / band), float(line.quad[:, 0].min())),
    )


class Engine:
    """Lazily-constructed, warm, thread-safe PaddleOCR front end."""

    def __init__(self, langs: list[str] | None = None) -> None:
        configured = langs or [
            lang.strip()
            for lang in os.environ.get("PADDLE_LANGS", "en,devanagari").split(",")
            if lang.strip()
        ]
        self.langs = configured
        self._engines: dict[str, Any] = {}
        self._lock = threading.Lock()
        # FastAPI runs sync endpoints on a threadpool, and a PaddleOCR predictor
        # is not safe to enter from two threads at once. Serialise inference: a
        # single CPU-bound engine gains nothing from concurrency anyway.
        self._infer_lock = threading.Lock()
        self._version = os.environ.get("PADDLE_OCR_VERSION", "PP-OCRv5")

    @property
    def model_version(self) -> str:
        """Stamped onto every OCR row in the database, so it must be specific."""
        return f"paddleocr-3/{self._version}/{'+'.join(self.langs)}"

    def _engine_for(self, lang: str):
        """One PaddleOCR instance per language, built on first use and kept."""
        if lang in self._engines:
            return self._engines[lang]
        with self._lock:
            if lang in self._engines:
                return self._engines[lang]
            from paddleocr import PaddleOCR

            # Document unwarping and the document-orientation classifier are for
            # scanned pages, not packets held up to a phone; they cost load time
            # and can misfire on a curved wrapper. Our own deskew handles tilt.
            # Textline orientation stays ON: rotated text is common on packaging.
            self._engines[lang] = PaddleOCR(
                lang=lang,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=True,
            )
            return self._engines[lang]

    def warmup(self) -> None:
        """Build every configured engine now, so the first scan is not the one that pays."""
        for lang in self.langs:
            self._engine_for(lang)

    @property
    def ready(self) -> bool:
        return len(self._engines) == len(self.langs)

    def _recognise(self, image: np.ndarray, lang: str) -> list[Line]:
        result = self._engine_for(lang).predict(image)
        lines: list[Line] = []
        for page in result or []:
            # PaddleOCR 3.x returns a result object that behaves like a dict.
            data = page.get("res", page) if hasattr(page, "get") else page
            polys = data.get("rec_polys") or data.get("dt_polys") or []
            texts = data.get("rec_texts") or []
            scores = data.get("rec_scores") or []
            for poly, text, score in zip(polys, texts, scores):
                cleaned = " ".join(str(text).split())
                if not cleaned:
                    continue
                lines.append(
                    Line(
                        text=cleaned,
                        quad=np.asarray(poly, dtype=np.float64).reshape(-1, 2),
                        confidence=float(score),
                        lang=lang,
                    )
                )
        return lines

    def recognise(self, image: np.ndarray) -> tuple[list[Line], dict[str, Any]]:
        """
        Run every configured recogniser and merge their readings.

        Where two recognisers found the same box, the higher-confidence reading
        wins - except that a Latin model transliterating Devanagari always scores
        itself plausibly while producing nonsense, so a reading that actually
        contains Devanagari is preferred over one that does not for the same box.
        """
        timings: dict[str, Any] = {}
        merged: list[Line] = []
        for lang in self.langs:
            started = time.perf_counter()
            with self._infer_lock:
                found = self._recognise(image, lang)
            timings[f"recognise_{lang}_ms"] = round((time.perf_counter() - started) * 1000)
            for line in found:
                for i, existing in enumerate(merged):
                    if _iou(existing.quad, line.quad) < MERGE_IOU:
                        continue
                    incoming_dev = bool(DEVANAGARI.search(line.text))
                    existing_dev = bool(DEVANAGARI.search(existing.text))
                    if incoming_dev != existing_dev:
                        better = incoming_dev  # the script-native reading wins
                    else:
                        better = line.confidence > existing.confidence
                    if better:
                        merged[i] = line
                    break
                else:
                    merged.append(line)
        return reading_order(merged), timings


_engine: Engine | None = None


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = Engine()
    return _engine
