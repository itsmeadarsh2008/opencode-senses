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
* shutdown  -> exit(0)

source := {"type": "path", "path": str} | {"type": "data", "data": dataUrl}
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
import traceback
from typing import Any, Dict

from PIL import Image

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


def _resolve_image(source: dict) -> Image.Image:
    kind = source.get("type")
    if kind == "path":
        path = source["path"]
        if not os.path.isfile(path):
            raise FileNotFoundError(f"image file not found: {path}")
        return Image.open(path)
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
