"""
Image preparation for OCR - OpenCV + Pillow.

Label photographs taken in a shop are rarely OCR-ready: the phone is held at an
angle, the packet fills half the frame, the plastic throws glare, and the
statutory declarations are the smallest print on the package. This module fixes
what can be fixed deterministically, before PaddleOCR sees the pixels.

Two properties matter more than the enhancement itself, because a compliance
verdict is formed from these pixels:

1. EVERY operation is recorded. `Prepared.ops` lists exactly what ran and with
   which parameters; the caller stores that alongside the processed image, so
   "what was done to the officer's photograph" is always answerable.

2. Geometry is invertible. Rotating, cropping and scaling move text away from
   where it sits in the original photograph. We keep the composite affine matrix
   and hand back its inverse, so OCR boxes can be reported in the coordinates of
   the image the officer actually took. Nothing downstream has to know that
   preprocessing happened.

Nothing here removes content. The crop is the bounding box of ALL detected text
plus a margin, so it can only ever discard background.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps

# --- Bounds -----------------------------------------------------------------
# Below MIN_SIDE the detector has too few pixels on 1.5 mm statutory print to
# resolve it; above MAX_SIDE we pay latency for detail the recogniser does not
# use. Applied to the shorter and longer side respectively, in pixels.
MIN_SIDE = 1024
MAX_SIDE = 2560

# Ceiling on upscaling. Interpolating a thumbnail up to MIN_SIDE does not recover
# print that was never captured, and past about 3x the resampling starts
# manufacturing edges an OCR engine will read as characters. A capture too small
# to reach MIN_SIDE within this factor stays under it, and its poor confidence
# scores are then an honest signal to recapture.
MAX_UPSCALE = 3.0

# Rotating by a hair costs a resample and gains nothing; a huge estimated angle
# means the estimate is wrong (a barcode edge, a package seam) rather than that
# the label is crooked. Only correct inside this band.
DESKEW_MIN_DEG = 0.4
DESKEW_MAX_DEG = 20.0

# Only crop when it removes a worthwhile amount of background.
CROP_MIN_GAIN = 0.10
CROP_MARGIN = 0.04

EXIF_ORIENTATION_TAG = 274


@dataclass
class Prepared:
    """The processed image plus everything needed to explain and undo it."""

    image: np.ndarray  # BGR, ready for PaddleOCR
    ops: list[dict[str, Any]] = field(default_factory=list)
    input_size: tuple[int, int] = (0, 0)  # (w, h) after EXIF, before processing
    output_size: tuple[int, int] = (0, 0)
    # 2x3 affine mapping processed-image points back to input-image points.
    inverse: np.ndarray | None = None

    def to_input_coords(self, pts: np.ndarray) -> np.ndarray:
        """Map Nx2 points from processed-image space back to the original photo."""
        if self.inverse is None:
            return pts
        homo = np.hstack([pts, np.ones((len(pts), 1), dtype=np.float64)])
        return homo @ self.inverse.T


def _as_3x3(matrix: np.ndarray) -> np.ndarray:
    """Promote a 2x3 affine to 3x3 so transforms compose by multiplication."""
    return np.vstack([matrix, [0.0, 0.0, 1.0]])


def decode(data: bytes) -> tuple[np.ndarray, bool]:
    """
    Decode via Pillow so EXIF orientation is honoured.

    A phone writes the sensor image plus an orientation tag; cv2.imdecode ignores
    the tag and hands back a sideways label. Every viewer applies it, so the
    upright image is what the officer believes they photographed - that, and not
    the raw sensor buffer, is the coordinate space we report boxes in.
    """
    with Image.open(io.BytesIO(data)) as im:
        orientation = im.getexif().get(EXIF_ORIENTATION_TAG, 1)
        rotated = ImageOps.exif_transpose(im)
        rgb = rotated.convert("RGB")
        arr = np.asarray(rgb)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR), orientation not in (1, None)


def _text_mask(bgr: np.ndarray) -> np.ndarray:
    """
    Rough mask of where printing is, used for both deskew and cropping.

    Morphological gradient answers "is there a stroke edge here", which survives
    the uneven lighting and coloured artwork of packaging far better than a
    global threshold. Closing with a wide, short kernel then glues characters
    into word and line blobs whose orientation is measurable.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    grad = cv2.morphologyEx(
        gray, cv2.MORPH_GRADIENT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    )
    _, binary = cv2.threshold(grad, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(9, bgr.shape[1] // 60), 3))
    return cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)


def _line_blobs(bgr: np.ndarray) -> list[np.ndarray]:
    """
    Contours that plausibly are lines of text.

    RETR_LIST, not RETR_EXTERNAL: a label with a printed border or a dark frame
    produces one outer contour enclosing everything, and asking only for outermost
    contours then yields exactly that one useless blob. We want what is inside it.

    Blobs bigger than a third of the image are that frame, or the packet's own
    outline; blobs below min_area are speckle. Neither says anything about the
    tilt of the printing.
    """
    mask = _text_mask(bgr)
    contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    total = float(bgr.shape[0] * bgr.shape[1])
    return [
        c for c in contours
        if total * 0.0004 <= cv2.contourArea(c) <= total * 0.33
    ]


def _blob_angle(contour: np.ndarray) -> float | None:
    """
    Tilt of a blob's long axis in degrees, wrapped to (-45, 45].

    Measured from the corner points rather than read off minAreaRect's `angle`,
    because that field's range changed convention in OpenCV 4.5 (this build
    reports 90.0 for perfectly level text, older ones reported 0.0). The angle of
    the longest edge is the same number under either convention.
    """
    box = cv2.boxPoints(cv2.minAreaRect(contour))
    edges = [box[(i + 1) % 4] - box[i] for i in range(4)]
    longest = max(edges, key=lambda e: float(np.hypot(e[0], e[1])))
    if float(np.hypot(longest[0], longest[1])) < 1.0:
        return None
    angle = float(np.degrees(np.arctan2(longest[1], longest[0])))
    while angle <= -45.0:
        angle += 90.0
    while angle > 45.0:
        angle -= 90.0
    return angle


def _estimate_skew(bgr: np.ndarray) -> float:
    """
    Median tilt of the text lines, in degrees. Returns 0.0 with nothing to go on.

    The median rather than the mean is deliberate: a barcode, a package edge or a
    curved seam produces a wildly tilted blob, and one such outlier would drag a
    mean far enough to rotate a straight label crooked.
    """
    angles = []
    for contour in _line_blobs(bgr):
        angle = _blob_angle(contour)
        if angle is not None and abs(angle) <= DESKEW_MAX_DEG:
            angles.append(angle)
    if len(angles) < 3:
        return 0.0
    return float(np.median(angles))


def _rotate(bgr: np.ndarray, degrees: float) -> tuple[np.ndarray, np.ndarray]:
    """Rotate about the centre, growing the canvas so no corner is clipped."""
    h, w = bgr.shape[:2]
    matrix = cv2.getRotationMatrix2D((w / 2, h / 2), degrees, 1.0)
    cos, sin = abs(matrix[0, 0]), abs(matrix[0, 1])
    new_w, new_h = int(h * sin + w * cos), int(h * cos + w * sin)
    matrix[0, 2] += (new_w / 2) - w / 2
    matrix[1, 2] += (new_h / 2) - h / 2
    out = cv2.warpAffine(
        bgr, matrix, (new_w, new_h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
    )
    return out, matrix


def _text_bounds(bgr: np.ndarray) -> tuple[int, int, int, int] | None:
    """Bounding box of every text-like blob, or None when nothing looks like text."""
    boxes = [cv2.boundingRect(c) for c in _line_blobs(bgr)]
    if not boxes:
        return None
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[0] + b[2] for b in boxes),
        max(b[1] + b[3] for b in boxes),
    )


def _enhance(bgr: np.ndarray) -> tuple[np.ndarray, list[dict[str, Any]]]:
    """
    Contrast, denoise, sharpen - in that order, and all of them gentle.

    CLAHE runs on L in LAB rather than on RGB, so colour is untouched and only
    lightness is equalised; that is what lifts dark grey 1.5 mm print off printed
    artwork. It is also tiled, so a glare patch in one corner cannot wash out the
    whole face the way a global histogram stretch would.

    Bilateral filtering smooths paper grain and JPEG mosquito noise while keeping
    stroke edges sharp - a plain blur would eat the thin strokes the recogniser
    needs. The unsharp mask then restores edge contrast lost to resampling and
    filtering. Weights stay conservative: over-sharpening manufactures serifs,
    and an OCR engine will happily read them as characters.
    """
    ops: list[dict[str, Any]] = []

    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    lightness, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    out = cv2.cvtColor(cv2.merge([clahe.apply(lightness), a, b]), cv2.COLOR_LAB2BGR)
    ops.append({"op": "clahe", "clipLimit": 2.0, "tileGridSize": [8, 8], "space": "LAB:L"})

    out = cv2.bilateralFilter(out, d=5, sigmaColor=45, sigmaSpace=45)
    ops.append({"op": "denoise", "method": "bilateral", "d": 5, "sigmaColor": 45, "sigmaSpace": 45})

    blurred = cv2.GaussianBlur(out, (0, 0), sigmaX=1.2)
    out = cv2.addWeighted(out, 1.5, blurred, -0.5, 0)
    ops.append({"op": "sharpen", "method": "unsharp_mask", "sigma": 1.2, "amount": 0.5})

    return out, ops


def prepare(
    data: bytes,
    *,
    deskew: bool = True,
    crop: bool = True,
    enhance: bool = True,
    min_side: int = MIN_SIDE,
    max_side: int = MAX_SIDE,
) -> Prepared:
    """Run the full preparation chain and return the image plus its audit trail."""
    bgr, exif_applied = decode(data)
    input_h, input_w = bgr.shape[:2]
    ops: list[dict[str, Any]] = []
    if exif_applied:
        ops.append({"op": "exif_transpose"})

    # Composite of every geometric step, in input-image coordinates.
    transform = np.eye(3, dtype=np.float64)

    # 1. Bound the working size before the expensive steps. An oversized capture
    #    costs seconds in deskew and detection for detail the recogniser drops.
    longest = max(bgr.shape[:2])
    if longest > max_side:
        scale = max_side / longest
        bgr = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        transform = _as_3x3(np.array([[scale, 0, 0], [0, scale, 0]])) @ transform
        ops.append(
            {
                "op": "resize",
                "reason": "bound_max_side",
                "scale": round(scale, 4),
                "to": [bgr.shape[1], bgr.shape[0]],
            }
        )

    # 2. Straighten the text lines. Skew costs the recogniser accuracy directly,
    #    and every later step works better on level text.
    if deskew:
        angle = _estimate_skew(bgr)
        if DESKEW_MIN_DEG <= abs(angle) <= DESKEW_MAX_DEG:
            bgr, matrix = _rotate(bgr, angle)
            transform = _as_3x3(matrix) @ transform
            ops.append({"op": "rotate", "reason": "deskew", "degrees": round(angle, 3)})
        else:
            ops.append({"op": "rotate", "skipped": True, "estimatedDegrees": round(angle, 3)})

    # 3. Crop to the printing. This is the union of ALL text blobs plus a margin,
    #    so it can only remove background - never a declaration. Backing off when
    #    the gain is small avoids shaving a border off an already tight photo.
    if crop:
        bounds = _text_bounds(bgr)
        if bounds:
            h, w = bgr.shape[:2]
            mx, my = int(w * CROP_MARGIN), int(h * CROP_MARGIN)
            x0 = max(0, bounds[0] - mx)
            y0 = max(0, bounds[1] - my)
            x1 = min(w, bounds[2] + mx)
            y1 = min(h, bounds[3] + my)
            kept = ((x1 - x0) * (y1 - y0)) / float(w * h)
            if kept < (1.0 - CROP_MIN_GAIN) and (x1 - x0) > 64 and (y1 - y0) > 64:
                bgr = bgr[y0:y1, x0:x1]
                transform = _as_3x3(np.array([[1.0, 0, -x0], [0, 1.0, -y0]])) @ transform
                ops.append(
                    {
                        "op": "crop",
                        "reason": "text_bounds",
                        "box": [x0, y0, x1, y1],
                        "areaKept": round(kept, 3),
                    }
                )
            else:
                ops.append({"op": "crop", "skipped": True, "areaKept": round(kept, 3)})
        else:
            ops.append({"op": "crop", "skipped": True, "reason": "no_text_found"})

    # 4. Upscale a small capture. After cropping, so the extra pixels go to the
    #    label rather than to the shop floor around it.
    shortest = min(bgr.shape[:2])
    if shortest < min_side:
        scale = min(min_side / shortest, MAX_UPSCALE)
        bgr = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        transform = _as_3x3(np.array([[scale, 0, 0], [0, scale, 0]])) @ transform
        ops.append(
            {
                "op": "resize",
                "reason": "upscale_small_capture",
                "scale": round(scale, 4),
                "to": [bgr.shape[1], bgr.shape[0]],
            }
        )

    # 5. Photometric clean-up last, so contrast and sharpening apply to the
    #    pixels the recogniser will actually read, at their final scale.
    if enhance:
        bgr, enhance_ops = _enhance(bgr)
        ops.extend(enhance_ops)

    inverse = cv2.invertAffineTransform(transform[:2, :])
    return Prepared(
        image=bgr,
        ops=ops,
        input_size=(input_w, input_h),
        output_size=(bgr.shape[1], bgr.shape[0]),
        inverse=inverse,
    )


def encode_png(bgr: np.ndarray) -> bytes:
    """PNG, not JPEG: the derived image is evidence, so it is stored losslessly."""
    ok, buf = cv2.imencode(".png", bgr, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise RuntimeError("could not PNG-encode the processed image")
    return buf.tobytes()
