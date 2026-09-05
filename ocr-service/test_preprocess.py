"""
Tests for the OpenCV/Pillow preparation stage.

No PaddleOCR here on purpose: these run offline in under a second and cover the
part that has to be right for the evidence trail to mean anything - that
geometry is invertible, and that nothing silently eats a declaration.

    ../.venv/Scripts/python -m pytest ocr-service/test_preprocess.py
"""
from __future__ import annotations

import cv2
import numpy as np
import pytest

import preprocess


def synthetic_label(width: int = 900, height: int = 700) -> np.ndarray:
    """A plain label: dark text lines on a light ground, inside a printed border."""
    img = np.full((height, width, 3), 235, dtype=np.uint8)
    cv2.rectangle(img, (20, 20), (width - 20, height - 20), (60, 60, 60), 3)
    lines = [
        "CRISPY WAFERS",
        "Net Qty: 150 g",
        "MRP Rs. 20 incl of all taxes",
        "Mfd by Snacky Foods, Pune 411001",
        "Consumer care: care@snacky.example",
        "Month of packing: 03/2026",
    ]
    for i, text in enumerate(lines):
        cv2.putText(img, text, (60, 120 + i * 80), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (20, 20, 20), 2)
    return img


def rotate_image(img: np.ndarray, degrees: float) -> tuple[np.ndarray, np.ndarray]:
    h, w = img.shape[:2]
    matrix = cv2.getRotationMatrix2D((w / 2, h / 2), degrees, 1.0)
    cos, sin = abs(matrix[0, 0]), abs(matrix[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    matrix[0, 2] += nw / 2 - w / 2
    matrix[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(img, matrix, (nw, nh), borderValue=(235, 235, 235)), matrix


def encode(img: np.ndarray) -> bytes:
    return cv2.imencode(".png", img)[1].tobytes()


def test_level_label_is_not_rotated():
    """A straight capture must be left alone - a needless warp only costs detail."""
    prepared = preprocess.prepare(encode(synthetic_label()))
    rotate_ops = [op for op in prepared.ops if op["op"] == "rotate"]
    assert rotate_ops and rotate_ops[0].get("skipped") is True


@pytest.mark.parametrize("angle", [-8.0, -3.0, 5.0, 9.0])
def test_skew_is_detected_and_corrected(angle):
    """
    Whatever tilt goes in comes out level.

    This is the regression that matters: a border-frame contour used to swallow
    every text line, leaving too few angles to measure and silently skipping
    deskew altogether.
    """
    tilted, _ = rotate_image(synthetic_label(), angle)
    measured = preprocess._estimate_skew(tilted)
    assert measured == pytest.approx(-angle, abs=1.0)

    prepared = preprocess.prepare(encode(tilted), crop=False, enhance=False)
    assert preprocess._estimate_skew(prepared.image) == pytest.approx(0.0, abs=0.6)


def test_boxes_map_back_to_the_original_photograph():
    """
    A point found in the processed image must map to the same ink in the original.

    Preprocessing rotates and crops; if the inverse were wrong, every OCR box
    would be reported against pixels the officer never saw there.
    """
    original = synthetic_label()
    tilted, matrix = rotate_image(original, 7.0)
    prepared = preprocess.prepare(encode(tilted), enhance=False)

    # Corners of the processed image, mapped back into the tilted original.
    h, w = prepared.image.shape[:2]
    corners = np.array([[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]])
    mapped = prepared.to_input_coords(corners)

    # The mapped region must sit inside the original frame (a crop can only ever
    # be a sub-region of it), allowing a pixel of rounding slack.
    assert mapped[:, 0].min() >= -1.5
    assert mapped[:, 1].min() >= -1.5
    assert mapped[:, 0].max() <= tilted.shape[1] + 1.5
    assert mapped[:, 1].max() <= tilted.shape[0] + 1.5


def test_crop_keeps_every_line_of_text():
    """The crop is the union of all text, so no declaration can fall outside it."""
    label = synthetic_label()
    padded = cv2.copyMakeBorder(label, 220, 220, 220, 220, cv2.BORDER_CONSTANT, value=(235, 235, 235))
    before = len(preprocess._line_blobs(padded))

    prepared = preprocess.prepare(encode(padded), deskew=False, enhance=False)
    crop_ops = [op for op in prepared.ops if op["op"] == "crop"]
    assert crop_ops and crop_ops[0].get("reason") == "text_bounds"

    # Cropping removed background, not content.
    assert prepared.output_size[0] < padded.shape[1]
    assert len(preprocess._line_blobs(prepared.image)) >= before


def test_capture_below_min_side_is_upscaled():
    small = cv2.resize(synthetic_label(), (700, 545))
    prepared = preprocess.prepare(encode(small), deskew=False, crop=False, enhance=False)
    assert min(prepared.output_size) >= preprocess.MIN_SIDE


def test_upscaling_stops_at_the_cap_rather_than_inventing_detail():
    """A thumbnail is not upscaled without limit - beyond MAX_UPSCALE the
    resampling manufactures edges that read as characters."""
    tiny = cv2.resize(synthetic_label(), (400, 311))
    prepared = preprocess.prepare(encode(tiny), deskew=False, crop=False, enhance=False)
    assert min(prepared.output_size) == pytest.approx(311 * preprocess.MAX_UPSCALE, abs=2)
    assert min(prepared.output_size) < preprocess.MIN_SIDE


def test_oversized_capture_is_bounded():
    huge = cv2.resize(synthetic_label(), (4200, 3200))
    prepared = preprocess.prepare(encode(huge), deskew=False, crop=False, enhance=False)
    assert max(prepared.output_size) <= preprocess.MAX_SIDE


def test_every_operation_is_recorded():
    """The ops list is the audit trail; an unrecorded change to the pixels is a hole in it."""
    prepared = preprocess.prepare(encode(synthetic_label()))
    recorded = [op["op"] for op in prepared.ops]
    for expected in ("rotate", "crop", "clahe", "denoise", "sharpen"):
        assert expected in recorded


def test_corrupt_upload_raises():
    with pytest.raises(Exception):
        preprocess.prepare(b"this is not an image")
