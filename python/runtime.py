"""Senses Vision Runtime.

A line-delimited JSON (NDJSON) JSON-RPC service over stdio that wraps the
Moondream 3.1 Photon runtime. The OpenCode plugin spawns this process and
sends one JSON message per line on stdin; each message is answered with one
JSON message on stdout.

The runtime owns the model lifecycle: it lazy-loads the model on the first
inference request, keeps it warm across calls, and can be told to unload so
the GPU is released back to the host model (or other processes).

Protocol
--------
Request : {"id": int, "method": str, "params": {...}}
Response: {"id": int, "result": {...}}
          {"id": int, "error": {"code": str, "message": str}}

Methods
-------
* ping      -> {"pong": true, "version": str, "device": str}
* status    -> model/device/vram/capabilities/request_count
* load      -> ensure model loaded (warm start)
* unload    -> free the model
* query     -> visual question answering
* caption   -> image captioning
* scene     -> structured deep-read (type, layout, elements, state)
* detect    -> object detection (bounding boxes)
* point     -> object pointing (center points)
* segment   -> object segmentation (SVG path)
* ocr       -> exact text extraction via visual query
* metadata  -> dimensions/format/bytes/exif (no model)
* crop      -> save a normalized bbox region to a PNG file (no model)
* zoom      -> upscale a region (LANCZOS), optionally re-analyze it
* colors    -> dominant palette + luminance stats (no model)
* diff      -> pixel-level change map between two images
* annotate  -> draw boxes/points onto a copy (no model)
* hash_search -> local perceptual-hash reverse search (no model)
* reverse   -> reverse image search: local + Yandex (no API key)
* shutdown  -> exit(0)

source := {"type": "path", "path": str} | {"type": "data", "data": dataUrl}

path sources may be http(s) URLs; the TypeScript side downloads them
verbatim into the cache before they reach this runtime.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import secrets
import sys
import time
import traceback
import urllib.parse
import urllib.request
from typing import Any, Dict

from PIL import Image

# Silence benign third-party chatter (HF-token hints, API-key notes) unless
# the user explicitly asked for debug logs via SENSES_DEBUG=1.
if os.environ.get("SENSES_DEBUG") != "1":
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    import logging
    import warnings

    warnings.filterwarnings("ignore")
    for _name in ("huggingface_hub", "transformers", "moondream.photLib", "moondream"):
        logging.getLogger(_name).setLevel(logging.ERROR)

MODEL_STATE: Dict[str, Any] = {
    "model": None,
    "model_id": None,
    "device": None,
    "capabilities": {},
    "initialized_ms": None,
    "request_count": 0,
    "last_inference_ms": None,
    "started_at": time.time(),
}

DEFAULT_MODEL = "moondream2"

# Tasks that require Moondream 3.x (absent from the "moondream2" checkpoint).
MOONDREAM3_ONLY_TASKS = {"segment", "reason", "ocr"}


def _cache_dir() -> str:
    base = os.environ.get("SENSES_CACHE_DIR") or os.path.join(
        os.path.expanduser("~"), ".cache", "opencode-senses"
    )
    os.makedirs(base, exist_ok=True)
    return base


def _converted_dir() -> str:
    d = os.path.join(_cache_dir(), "converted")
    os.makedirs(d, exist_ok=True)
    return d


def _decode_for_analysis(path: str, opened: Image.Image) -> Image.Image:
    """PIL cannot open all formats (SVG, HEIC). Try optional decoders and keep
    a PNG analysis copy; the original file is never modified."""
    try:
        opened.seek(0)
        opened.convert("RGB")  # forces a real decode
        opened.seek(0)
        return opened
    except Exception:
        pass
    converted = os.path.join(
        _converted_dir(), f"{hashlib.sha256(path.encode()).hexdigest()[:12]}.png"
    )
    try:
        import cairosvg  # type: ignore
    except ImportError:
        cairosvg = None
    if cairosvg is not None and path.lower().endswith(".svg"):
        cairosvg.svg2png(url=path, write_to=converted, output_width=2048)
        return Image.open(converted).convert("RGB")
    try:
        pillow_heif = __import__("pillow_heif")  # type: ignore
    except ImportError:
        pillow_heif = None
    if pillow_heif is not None:
        try:
            pillow_heif.register_heif_opener()
            Image.open(path).convert("RGB").save(converted)
            return Image.open(converted).convert("RGB")
        except Exception:
            pass
    raise ValueError(
        f"cannot decode image format for '{path}': install optional codecs "
        "('pip install cairosvg' for SVG, 'pip install pillow-heif' for HEIC) "
        "or convert the image to PNG/JPEG"
    )


def _resolve_image(source: dict) -> Image.Image:
    kind = source.get("type")
    if kind == "path":
        path = source["path"]
        if not os.path.isfile(path):
            raise FileNotFoundError(f"image file not found: {path}")
        return _decode_for_analysis(path, Image.open(path))
    if kind == "data":
        data = source["data"]
        if "," in data:
            data = data.split(",", 1)[1]
        return Image.open(io.BytesIO(base64.b64decode(data)))
    raise ValueError(f"unsupported source type: {kind}")


def _device_of() -> str:
    if MODEL_STATE["device"]:
        return MODEL_STATE["device"]
    try:
        import torch

        if torch.cuda.is_available():
            return (
                f"cuda:{torch.cuda.current_device()} ({torch.cuda.get_device_name(0)})"
            )
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
        return "cpu"
    except Exception:
        return "unknown"


def _ensure_model(model_name: str | None = None) -> Any:
    cache = MODEL_STATE
    if cache["model"] is not None:
        return cache["model"]

    model_name = model_name or os.environ.get("SENSES_MODEL", DEFAULT_MODEL)
    started = time.time()

    import moondream

    kwargs = {}
    api_key = os.environ.get("MOONDREAM_API_KEY")
    if api_key:
        kwargs["api_key"] = api_key

    # Small-card tuning: keep the KV cache and batching minimal so the model
    # fits comfortably in 6 GB VRAM. Overridable via env for bigger GPUs.
    if os.environ.get("SENSES_KV_CACHE_PAGES"):
        try:
            kwargs["kv_cache_pages"] = int(os.environ["SENSES_KV_CACHE_PAGES"])
        except ValueError:
            pass
    else:
        kwargs.setdefault("kv_cache_pages", 4096)
    kwargs.setdefault("max_batch_size", 1)
    kwargs.setdefault("enable_cuda_graphs", False)
    kwargs.setdefault("enable_prefix_cache", False)

    model = moondream.photon(model_name, **kwargs)
    cache["model"] = model
    cache["model_id"] = getattr(model, "model_id", model_name)
    cache["device"] = _device_of()
    cache["initialized_ms"] = int((time.time() - started) * 1000)
    try:
        tasks = model.tasks
        sup = getattr(model, "supports", None)
        if callable(sup):
            caps = {t: bool(sup(t)) for t in tasks}
        else:
            caps = {t: True for t in tasks}
    except Exception:
        caps = {}
    cache["capabilities"] = caps
    return model


def _supports(task: str) -> bool:
    """Whether the loaded model advertises `task`. Always True if unknown."""
    caps = MODEL_STATE["capabilities"]
    if not caps:
        return True
    return caps.get(task, False)


def _require_task(task: str) -> None:
    if not _supports(task):
        raise ValueError(
            f"task '{task}' is not supported by model '{MODEL_STATE['model_id'] or '?'}'"
        )


def _unload_model() -> dict:
    model = MODEL_STATE.pop("model", None)
    if model is not None:
        try:
            model.close()
        except Exception:
            pass
    MODEL_STATE["model_id"] = None
    MODEL_STATE["initialized_ms"] = None
    MODEL_STATE["capabilities"] = {}
    return {"ok": True}


def _timed(fn, *args, **kwargs):
    started = time.perf_counter()
    result = fn(*args, **kwargs)
    MODEL_STATE["request_count"] += 1
    MODEL_STATE["last_inference_ms"] = int((time.perf_counter() - started) * 1000)
    return result


def handle_ping(_params: dict) -> dict:
    return {"result": {"pong": True, "device": _device_of()}}


def handle_status(_params: dict) -> dict:
    model_loaded = MODEL_STATE["model"] is not None
    device = _device_of()
    gpu = {}
    try:
        import torch

        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            gpu = {
                "name": props.name,
                "total_vram_gb": round(props.total_memory / (1024**3), 2),
                "used_vram_gb": round(torch.cuda.memory_allocated(0) / (1024**3), 2),
                "reserved_vram_gb": round(torch.cuda.memory_reserved(0) / (1024**3), 2),
            }
    except Exception:
        pass
    return {
        "result": {
            "model_loaded": model_loaded,
            "model_id": MODEL_STATE["model_id"],
            "device": device,
            "gpu": gpu,
            "capabilities": MODEL_STATE["capabilities"],
            "initialized_ms": MODEL_STATE["initialized_ms"],
            "request_count": MODEL_STATE["request_count"],
            "last_inference_ms": MODEL_STATE["last_inference_ms"],
            "uptime_s": int(time.time() - MODEL_STATE["started_at"]),
        }
    }


def handle_load(params: dict) -> dict:
    _ensure_model(params.get("model"))
    return {"result": {"loaded": True}}


def handle_unload(_params: dict) -> dict:
    return {"result": _unload_model()}


def handle_query(params: dict) -> dict:
    image = _resolve_image(params["source"])
    model = _ensure_model(params.get("model"))
    kwargs = {}
    if _supports("reason") and params.get("reasoning"):
        kwargs["reasoning"] = True
    if _supports("spatial_refs") or params.get("spatial_refs"):
        if params.get("spatial_refs"):
            kwargs["spatial_refs"] = params["spatial_refs"]
    if params.get("settings"):
        kwargs["settings"] = params["settings"]
    res = _timed(
        model.query,
        image,
        question=params["question"],
        **kwargs,
    )
    out: dict = {"answer": res.get("answer")}
    if res.get("reasoning") is not None:
        out["reasoning"] = res["reasoning"]
    return {"result": {"type": "query", **out}}


def handle_caption(params: dict) -> dict:
    image = _resolve_image(params["source"])
    model = _ensure_model(params.get("model"))
    res = _timed(
        model.caption,
        image,
        length=params.get("length", "normal"),
        settings=params.get("settings") or None,
    )
    return {"result": {"type": "caption", "caption": res.get("caption")}}


SCENE_PROMPT = (
    "Study this image closely and describe what is actually shown. "
    "Answer in this exact structure:\n"
    "type: one of UI screenshot, terminal, code, error dialog, document, chart/diagram, photo, or other\n"
    "layout: the visual layout in a sentence or two, including where the main regions are.\n"
    "elements: bullet list the notable visible elements with a short descriptor each "
    "(e.g. navigation bar top-left, green Submit button bottom-right, empty state graphic, table column 'Total').\n"
    "state: anything notable about the current state, e.g. warnings, errors, loading, disabled controls, selected item.\n"
    "For code or text-heavy images, summarize what the code or document is about in one sentence; "
    "do not try to repeat the text verbatim (OCR covers that). Speak plainly and only about what is observable."
)


def handle_scene(params: dict) -> dict:
    image = _resolve_image(params["source"])
    model = _ensure_model(params.get("model"))
    kwargs: dict = {}
    if _supports("reason") and params.get("reasoning"):
        kwargs["reasoning"] = True
    res = _timed(
        model.query,
        image,
        question=SCENE_PROMPT,
        **kwargs,
    )
    return {"result": {"type": "scene", "scene": res.get("answer")}}


def _normalize_detect_objects(objects: list) -> list[dict]:
    out = []
    for obj in objects:
        if not isinstance(obj, dict):
            continue
        x1 = obj.get("x_min", obj.get("x1"))
        y1 = obj.get("y_min", obj.get("y1"))
        x2 = obj.get("x_max", obj.get("x2"))
        y2 = obj.get("y_max", obj.get("y2"))
        if x1 is None or y1 is None or x2 is None or y2 is None:
            continue
        out.append(
            {
                "x1": x1,
                "y1": y1,
                "x2": x2,
                "y2": y2,
                "confidence": obj.get("confidence"),
            }
        )
    return out


def _normalize_points(points: list) -> list:
    out = []
    for p in points:
        if not isinstance(p, dict):
            continue
        out.append(
            {"x": p.get("x"), "y": p.get("y"), "confidence": p.get("confidence")}
        )
    return out


def handle_detect(params: dict) -> dict:
    image = _resolve_image(params["source"])
    model = _ensure_model(params.get("model"))
    res = _timed(
        model.detect,
        image,
        object=params["target"],
        settings=params.get("settings") or None,
    )
    raw = res.get("objects", []) if isinstance(res, dict) else []
    return {"result": {"type": "detect", "objects": _normalize_detect_objects(raw)}}


def handle_point(params: dict) -> dict:
    image = _resolve_image(params["source"])
    model = _ensure_model(params.get("model"))
    res = _timed(
        model.point,
        image,
        object=params["target"],
        settings=params.get("settings") or None,
    )
    raw = res.get("points", []) if isinstance(res, dict) else []
    return {"result": {"type": "point", "points": _normalize_points(raw)}}


def handle_segment(params: dict) -> dict:
    image = _resolve_image(params["source"])
    model = _ensure_model(params.get("model"))
    _require_task("segment")
    try:
        res = _timed(
            model.segment,
            image,
            object=params["target"],
            settings=params.get("settings") or None,
        )
    except ValueError as exc:
        raise ValueError(
            f"task 'segment' is not supported by model '{MODEL_STATE['model_id'] or '?'}': {exc}"
        )
    out: dict = {}
    if res.get("path"):
        out["path"] = res["path"]
    if res.get("bbox"):
        out["bbox"] = res["bbox"]
    return {"result": {"type": "segment", **out}}


OCR_PROMPTS = {
    "all": (
        "Transcribe the text in this image. Include all visible text exactly as shown, "
        "preserving line breaks and positions as much as possible."
    ),
    "code": "This image shows a screenshot of code. Output every line of code text exactly, and only the code text.",
    "error": "Extract the error message(s) visible in this image exactly as shown, quoting them verbatim.",
}


def handle_ocr(params: dict) -> dict:
    kind = str(params.get("kind", "all")).strip().lower()
    prompt = OCR_PROMPTS.get(kind, OCR_PROMPTS["all"])
    image = _resolve_image(params["source"])
    model = _ensure_model(params.get("model"))
    res = _timed(
        model.query, image, question=prompt, settings=params.get("settings") or None
    )
    return {"result": {"type": "ocr", "text": res.get("answer")}}


def _bbox_to_px(bbox: dict, w: int, h: int) -> tuple[int, int, int, int]:
    x1 = max(0.0, min(1.0, float(bbox.get("x1", 0.0))))
    y1 = max(0.0, min(1.0, float(bbox.get("y1", 0.0))))
    x2 = max(0.0, min(1.0, float(bbox.get("x2", 1.0))))
    y2 = max(0.0, min(1.0, float(bbox.get("y2", 1.0))))
    if x2 <= x1 or y2 <= y1:
        raise ValueError(f"invalid bbox: {bbox}")
    px = (
        int(x1 * w),
        int(y1 * h),
        max(int(x2 * w), int(x1 * w) + 1),
        max(int(y2 * h), int(y1 * h) + 1),
    )
    return px


def _output_path(kind: str, suffix: str = "png") -> str:
    d = os.path.join(_cache_dir(), kind)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{int(time.time() * 1000)}-{secrets.token_hex(4)}.{suffix}")


def _exif_brief(image: Image.Image) -> dict:
    try:
        exif = image.getexif()
    except Exception:
        return {}
    labels = {
        271: "make",
        272: "model",
        306: "datetime",
        36867: "datetime_original",
        33432: "copyright",
    }
    out: dict = {}
    for tag, name in labels.items():
        if tag in exif and exif[tag]:
            out[name] = str(exif[tag])
    if 34853 in exif:
        gps = {tag: val for tag, val in exif[34853].items()}
        if gps:
            out["gps"] = True
    return out


def handle_metadata(params: dict) -> dict:
    source = params["source"]
    stat = os.stat(source["path"]) if source.get("type") == "path" else None
    image = _resolve_image(source)
    fmt = (image.format or "unknown").upper()
    dpi = image.info.get("dpi")
    result = {
        "width": image.width,
        "height": image.height,
        "format": fmt,
        "mode": image.mode,
        "dpi": [float(dpi[0]), float(dpi[1])] if dpi else None,
        "exif": _exif_brief(image),
    }
    if stat is not None:
        result["bytes"] = stat.st_size
    return {"result": {"type": "metadata", **result}}


def handle_crop(params: dict) -> dict:
    source = params["source"]
    image = _resolve_image(source).convert("RGB")
    w, h = image.size
    x1, y1, x2, y2 = _bbox_to_px(params["bbox"], w, h)
    crop = image.crop((x1, y1, x2, y2))
    path = _output_path("crops")
    crop.save(path)
    return {
        "result": {
            "type": "crop",
            "path": path,
            "width": crop.width,
            "height": crop.height,
            "bbox_px": [x1, y1, x2, y2],
        }
    }


def handle_zoom(params: dict) -> dict:
    source = params["source"]
    image = _resolve_image(source).convert("RGB")
    w, h = image.size
    region = params.get("region")
    if region:
        x1, y1, x2, y2 = _bbox_to_px(region, w, h)
        region_img = image.crop((x1, y1, x2, y2))
    else:
        region_img = image
    scale = max(1.0, min(8.0, float(params.get("scale", 2.0))))
    tw, th = int(region_img.width * scale), int(region_img.height * scale)
    if tw * th > 24_000_000:
        factor = (24_000_000 / (tw * th)) ** 0.5
        tw, th = int(tw * factor), int(th * factor)
        scale = th / region_img.height
    upscaled = region_img.resize((tw, th), Image.LANCZOS)
    path = _output_path("zooms")
    upscaled.save(path)

    out: dict = {
        "type": "zoom",
        "path": path,
        "width": tw,
        "height": th,
        "scale": round(scale, 2),
    }
    analyze = str(params.get("analyze", "none")).strip().lower()
    if analyze in ("ocr", "caption"):
        model = _ensure_model(params.get("model"))
        upscaled_rgb = upscaled.convert("RGB")
        res = _timed(
            model.caption if analyze == "caption" else model.query,
            upscaled_rgb,
            **(
                {"question": "Transcribe all text in this image exactly."}
                if analyze == "ocr"
                else {"length": "normal"}
            ),
        )
        text = res.get("caption") if analyze == "caption" else res.get("answer")
        out["analysis"] = {"kind": analyze, "text": text}
    elif analyze == "query":
        question = str(params.get("question") or "").strip()
        if not question:
            raise ValueError("analyze='query' requires a 'question'")
        model = _ensure_model(params.get("model"))
        res = _timed(model.query, upscaled.convert("RGB"), question=question)
        out["analysis"] = {"kind": "query", "text": res.get("answer")}
    return {"result": out}


def handle_colors(params: dict) -> dict:
    source = params["source"]
    image = _resolve_image(source).convert("RGB")
    w, h = image.size
    region = params.get("region")
    if region:
        x1, y1, x2, y2 = _bbox_to_px(region, w, h)
        image = image.crop((x1, y1, x2, y2))
        w, h = image.size
    palette = image.quantize(colors=5, method=2)
    counts = sorted(palette.getcolors(maxcolors=100000), reverse=True)
    total = w * h or 1
    dominant = []
    for count, idx in counts:
        r, g, b = palette.getpalette()[idx * 3 : idx * 3 + 3]  # type: ignore[index]
        dominant.append(
            {"hex": "#%02x%02x%02x" % (r, g, b), "share": round(count / total, 3)}
        )
    gray = image.convert("L")
    hist = gray.histogram()
    buckets = {"dark": 0, "mid": 0, "bright": 0}
    for i, c in enumerate(hist):
        if i < 56:
            buckets["dark"] += c
        elif i < 200:
            buckets["mid"] += c
        else:
            buckets["bright"] += c
    buckets = {k: round(v / total, 3) for k, v in buckets.items()}
    avg = tuple(round(v) for v in image.resize((1, 1)).getpixel((0, 0)))
    return {
        "result": {
            "type": "colors",
            "palette": dominant,
            "buckets": buckets,
            "avg_rgb": avg,
            "regions_analyzed": 1,
        }
    }


def handle_diff(params: dict) -> dict:
    source = params["source"]
    other = params["other"]
    a = _resolve_image(source).convert("RGB")
    b = _resolve_image(other).convert("RGB")
    if a.size != b.size:
        b = b.resize(a.size, Image.LANCZOS)
    from PIL import ImageChops, ImageFilter

    delta = ImageChops.difference(a, b).convert("L")
    delta = delta.filter(ImageFilter.GaussianBlur(1.5))
    bands = delta.point(lambda p: 255 if p > 24 else 0)
    total = a.width * a.height or 1
    changed = 0
    regions = []
    # band-row scan for changed regions
    rows = []
    for y in range(0, a.height, 8):
        row_changed = (
            sum(bands.crop((0, y, a.width, min(y + 8, a.height))).getdata()) > 0
        )
        if row_changed:
            rows.append(y)
    for y in rows:
        xs = [
            x
            for x in range(0, a.width, 8)
            if bands.getpixel((x, min(y, a.height - 1))) > 0
        ]
        if not xs:
            continue
        x1, x2 = xs[0] / a.width, (xs[-1] + 8) / a.width
        y1, y2 = y / a.height, (y + 8) / a.height
        if (
            regions
            and y1 - regions[-1]["y2"] <= 0.02
            and x1 <= regions[-1]["x2"]
            and x2 >= regions[-1]["x1"]
        ):
            regions[-1]["y2"] = y2
            regions[-1]["x1"] = min(regions[-1]["x1"], x1)
            regions[-1]["x2"] = max(regions[-1]["x2"], x2)
        else:
            regions.append(
                {
                    "x1": round(x1, 3),
                    "y1": round(y1, 3),
                    "x2": round(x2, 3),
                    "y2": round(y2, 3),
                }
            )
    diff_px = sum(bands.point(lambda p: 1 if p > 0 else 0).getdata())
    out: dict = {
        "type": "diff",
        "changed_pct": round(diff_px / total, 4),
        "regions": regions[:12],
        "width": a.width,
        "height": a.height,
    }
    if params.get("describe"):
        model = _ensure_model(params.get("model"))
        # composite: left source, right diff highlighted
        composite = Image.new("RGB", (a.width * 2, a.height))
        composite.paste(a, (0, 0))
        highlight = a.copy()
        highlight = Image.composite(
            Image.new("RGB", a.size, (255, 255, 255)),
            highlight,
            bands.point(lambda p: 160 if p > 0 else 0),
        )
        composite.paste(highlight, (a.width, 0))
        composite.thumbnail((1600, 1200))
        res = _timed(
            model.query,
            composite,
            question="The right half highlights all pixels that changed versus the left image (white overlay). Describe in one or two sentences what changed and where.",
        )
        out["description"] = res.get("answer")
    return {"result": out}


def handle_annotate(params: dict) -> dict:
    source = params["source"]
    image = _resolve_image(source).convert("RGB")
    boxes = params.get("boxes") or []
    points = params.get("points") or []
    logo = params.get("label") or ""
    if boxes or points:
        from PIL import ImageDraw

        draw = ImageDraw.Draw(image)
        w, h = image.size
        box_color = str(params.get("color") or "#ff3355")
        for b in boxes:
            x1, y1, x2, y2 = _bbox_to_px(b, w, h)
            draw.rectangle([x1, y1, x2, y2], outline=box_color, width=max(2, w // 400))
            label = b.get("label") or logo
            if label:
                draw.text((x1, max(0, y1 - 14)), label, fill=box_color)
        for p in points:
            label = p.get("label") or logo
            cx, cy = (
                round(float(p.get("x", 0.5)) * w),
                round(float(p.get("y", 0.5)) * h),
            )
            r = max(4, w // 220)
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=box_color, width=2)
            if label:
                draw.text((cx + r + 2, cy - 6), label, fill=box_color)
    path = _output_path("annotations")
    image.save(path)
    return {
        "result": {
            "type": "annotate",
            "path": path,
            "width": image.width,
            "height": image.height,
        }
    }


def _dhash64(image: Image.Image) -> int:
    gray = image.convert("L").resize((9, 8), Image.LANCZOS)
    px = list(gray.getdata())
    value = 0
    for y in range(8):
        for x in range(8):
            value = (value << 1) | (1 if px[y * 9 + x] < px[y * 9 + x + 1] else 0)
    return value


def _hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def _iter_images(root: str, recursive: bool):
    if not os.path.isdir(root):
        return
    if recursive:
        for dirpath, _dirnames, filenames in os.walk(root):
            if ".venv" in dirpath or "node_modules" in dirpath or ".git" in dirpath:
                continue
            for name in filenames:
                yield os.path.join(dirpath, name)
    else:
        for name in os.listdir(root):
            yield os.path.join(root, name)


IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".bmp",
    ".avif",
    ".tiff",
    ".tif",
    ".heic",
}


def handle_hash_search(params: dict) -> dict:
    source = params["source"]
    query = _dhash64(_resolve_image(source).convert("RGB"))
    root = str(params.get("dir") or "").strip()
    roots = []
    if root:
        roots.append(root)
        roots.append(os.path.join(_cache_dir(), "fetched"))
    else:
        roots.append(_cache_dir())
    limit = max(1, min(25, int(params.get("limit", 8))))
    matches = []
    seen: set[str] = set()
    for base in roots:
        for path in _iter_images(base, bool(params.get("recursive", True))):
            if path in seen or not path.lower().endswith(tuple(IMAGE_EXTENSIONS)):
                continue
            seen.add(path)
            try:
                d = _dhash64(Image.open(path).convert("RGB"))
            except Exception:
                continue
            dist = _hamming(query, d)
            if dist <= 6:
                matches.append(
                    {
                        "path": path,
                        "hamming": dist,
                        "similarity": round(1 - dist / 64, 3),
                    }
                )
    matches.sort(key=lambda m: m["hamming"])
    return {
        "result": {
            "type": "hash_search",
            "matches": matches[:limit],
            "scanned": len(seen),
            "limit": limit,
        }
    }


def _yandex_reverse(image_path: str) -> dict:
    """Upload an image to Yandex reverse image search. No API key required;
    follows the public search-by-image flow (multipart `upfile` POST to
    /images/search). May hit captcha/rate limits — errors are returned
    gracefully with a browser-ready fallback URL."""
    with open(image_path, "rb") as fh:
        image_bytes = fh.read()
    ext = os.path.splitext(image_path)[1].lower().lstrip(".") or "jpg"
    mime = {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
        "bmp": "image/bmp",
        "avif": "image/avif",
        "heic": "image/heic",
    }.get(ext, "application/octet-stream")
    boundary = "----SensesBoundary" + secrets.token_hex(8)
    body = io.BytesIO()
    body.write(f"--{boundary}\r\n".encode())
    body.write(
        f'Content-Disposition: form-data; name="upfile"; filename="image.{ext}"\r\n'
        f"Content-Type: {mime}\r\n\r\n".encode()
    )
    body.write(image_bytes)
    body.write(f"\r\n--{boundary}--\r\n".encode())
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
    opener.addheaders = [
        (
            "User-Agent",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        ),
        ("Accept", "*/*"),
    ]
    # Prime session cookies first — the search endpoint rejects cookie-less
    # uploads.
    landing = "https://yandex.com/images/search?rpt=imageview"
    try:
        with opener.open(urllib.request.Request(landing), timeout=20) as resp:
            resp.read()
    except Exception as exc:
        raise ValueError(
            f"Yandex reverse search could not reach {landing} ({exc}). Open it manually."
        )
    search_url = landing + "&cbir_page=sites"
    try:
        req = urllib.request.Request(
            search_url,
            data=body.getvalue(),
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Referer": landing,
            },
            method="POST",
        )
        with opener.open(req, timeout=30) as resp:
            final_url = resp.geturl()
            html = resp.read().decode("utf-8", "replace")
    except Exception as exc:
        raise ValueError(
            f"Yandex reverse search failed ({exc}). Open {landing} and upload manually."
        )
    out_matches: list[dict] = []
    pos_urls = re.findall(r'"pos_url":"([^"]+)"', html)[:6]
    for raw in pos_urls:
        url_value = raw.replace("\\/", "/")
        if url_value.startswith("//"):
            url_value = "https:" + url_value
        out_matches.append({"url": url_value, "source": "yandex", "title": None})
    if not out_matches:
        titles = re.findall(r'"title":"([^"]+)"', html)[:3]
        out_matches = [
            {"url": None, "source": "yandex", "title": t.replace("\\/", "/")[:120]}
            for t in titles
        ]
    return {"provider": "yandex", "search_url": final_url, "matches": out_matches}


def handle_reverse(params: dict) -> dict:
    source = params["source"]
    providers = [
        p.strip().lower()
        for p in str(params.get("providers") or "local,yandex").split(",")
    ]
    out: dict = {
        "type": "reverse",
        "query": source.get("path") or "inline-image",
        "results": [],
    }
    if "local" in providers:
        # Reuse hash_search over the cache + optional project dir.
        local = handle_hash_search(params)
        local_res = local["result"]
        out["results"].append(
            {
                "provider": "local",
                "matches": [
                    {"path": m["path"], "similarity": m["similarity"]}
                    for m in local_res["matches"]
                ],
                "scanned": local_res["scanned"],
            }
        )
    if "yandex" in providers:
        if source.get("type") != "path":
            raise ValueError(
                "yandex reverse search requires a file path (upload the file first)"
            )
        out["results"].append(_yandex_reverse(source["path"]))
    return {"result": out}


def handle_shutdown(_params: dict) -> dict:
    _unload_model()
    sys.stdout.write(json.dumps({"id": -1, "result": {"shutdown": True}}) + "\n")
    sys.stdout.flush()
    os._exit(0)


METHODS: Dict[str, Any] = {
    "ping": handle_ping,
    "status": handle_status,
    "load": handle_load,
    "unload": handle_unload,
    "query": handle_query,
    "caption": handle_caption,
    "scene": handle_scene,
    "detect": handle_detect,
    "point": handle_point,
    "segment": handle_segment,
    "ocr": handle_ocr,
    "metadata": handle_metadata,
    "crop": handle_crop,
    "zoom": handle_zoom,
    "colors": handle_colors,
    "diff": handle_diff,
    "annotate": handle_annotate,
    "hash_search": handle_hash_search,
    "reverse": handle_reverse,
    "shutdown": handle_shutdown,
}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            sys.stdout.write(
                json.dumps(
                    {"id": None, "error": {"code": "BAD_REQUEST", "message": str(exc)}}
                )
                + "\n"
            )
            sys.stdout.flush()
            continue

        rid = request.get("id")
        method = request.get("method", "")
        params = request.get("params") or {}

        handler = METHODS.get(method)
        if handler is None:
            sys.stdout.write(
                json.dumps(
                    {"id": rid, "error": {"code": "UNKNOWN_METHOD", "message": method}}
                )
                + "\n"
            )
            sys.stdout.flush()
            continue

        started = time.perf_counter()
        try:
            response = handler(params)
        except FileNotFoundError as exc:
            response = {
                "id": rid,
                "error": {"code": "INVALID_INPUT", "message": str(exc)},
            }
        except ValueError as exc:
            response = {
                "id": rid,
                "error": {"code": "INVALID_INPUT", "message": str(exc)},
            }
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            response = {
                "id": rid,
                "error": {"code": type(exc).__name__, "message": str(exc)},
            }
        else:
            response = {"id": rid, **response}
        response["_ms"] = int((time.perf_counter() - started) * 1000)
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
