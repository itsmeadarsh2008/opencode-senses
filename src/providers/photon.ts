import { resolve as resolvePath, isAbsolute, join as joinPath } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { RuntimeClient } from "../runtime/client.js";
import { SensesError } from "../runtime/client.js";

import type {
  AnnotateRequest,
  AnnotateResult,
  BBox,
  CaptionRequest,
  CaptionResult,
  ColorsRequest,
  ColorsResult,
  CropRequest,
  CropResult,
  DetectRequest,
  DetectionResult,
  DiffRequest,
  DiffResult,
  HashSearchRequest,
  HashSearchResult,
  ImageSource,
  MetadataRequest,
  MetadataResult,
  OCRRequest,
  OCRResult,
  PointRequest,
  PointResult,
  QueryRequest,
  QueryResult,
  ReverseSearchRequest,
  ReverseSearchResult,
  SceneRequest,
  SceneResult,
  SegmentRequest,
  SegmentResult,
  VisionHealth,
  VisionProvider,
  ZoomRequest,
  ZoomResult,
} from "./types.js";
import type { DetectedObject, Point } from "./types.js";

type ImportedDetectedObject = DetectedObject;
type ImportedPoint = Point;

const IMAGE_EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "image/heif": "heic",
};

function cacheDir(): string {
  return process.env.SENSES_CACHE_DIR ?? joinPath(homedir(), ".cache", "opencode-senses");
}

export function extForContentType(contentType: string, url: string): string {
  const ct = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  const byCt = ct ? IMAGE_EXT_BY_TYPE[ct] : undefined;
  if (byCt) return byCt;
  const m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url);
  const ext = m?.[1]?.toLowerCase();
  if (ext && IMAGE_EXT_BY_TYPE[`image/${ext === "jpg" ? "jpeg" : ext}`]) {
    return ext;
  }
  return "img";
}

/**
 * VisionProvider backed by the Senses Python runtime (Photon + Moondream 3.1).
 *
 * Calls are correlated over the stdio JSON-RPC channel. File-based image
 * sources are resolved relative to the caller's project directory so the
 * plugin stays thin and the Python side stays stateless. `path` arguments
 * may also be http(s) URLs: the image is downloaded verbatim (original type,
 * size, bytes untouched) into the local cache and the cached file is handed
 * to the runtime.
 */
export class PhotonProvider implements VisionProvider {
  readonly id = "photon";
  readonly model = "moondream2";

  private readonly client: RuntimeClient;
  private readonly projectDir: string;
  private readonly fetchTimeoutMs: number;

  constructor(
    client: RuntimeClient,
    opts: { projectDir?: string; fetchTimeoutMs?: number } = {},
  ) {
    this.client = client;
    this.projectDir = opts.projectDir ?? process.cwd();
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 60_000;
  }

  private async resolvePath(p: string): Promise<string> {
    if (/^https?:\/\//i.test(p)) return this.fetchToCache(p);
    return isAbsolute(p) ? p : resolvePath(this.projectDir, p);
  }

  /** Download a URL verbatim into the cache; bytes and type are preserved. */
  private async fetchToCache(url: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(this.fetchTimeoutMs),
      });
    } catch (err) {
      throw new SensesError(
        "FETCH_FAILED",
        `could not download ${url}: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new SensesError(
        "FETCH_FAILED",
        `download of ${url} failed with HTTP ${res.status} ${res.statusText}`,
      );
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new SensesError(
        "NOT_AN_IMAGE",
        `${url} returned content-type '${contentType || "unknown"}' — expected an image`,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = extForContentType(contentType, res.url || url);
    const sha = createHash("sha256").update(buf).digest("hex").slice(0, 16);
    const dir = joinPath(cacheDir(), "fetched");
    await mkdir(dir, { recursive: true });
    const path = joinPath(dir, `${sha}.${ext}`);
    await writeFile(path, buf);
    return path;
  }

  private async toSource(source: ImageSource): Promise<Record<string, unknown>> {
    if (source.type === "data") {
      return { type: "data", data: source.data };
    }
    return { type: "path", path: await this.resolvePath(source.path) };
  }

  async health(): Promise<VisionHealth> {
    const res = (await this.client.request("status")) as Record<string, unknown>;
    const gpu = res["gpu"] as
      | { name?: string; total_vram_gb?: number; used_vram_gb?: number }
      | undefined;
    return {
      provider: this.id,
      model: (res["model_id"] as string) ?? null,
      device: res["device"] as string,
      loaded: bool(res["model_loaded"]),
      vram: gpu
        ? {
            name: gpu.name ?? "unknown",
            totalGb: gpu.total_vram_gb ?? 0,
            usedGb: gpu.used_vram_gb ?? 0,
          }
        : undefined,
      requestCount: num(res["request_count"]),
      lastInferenceMs: numOrNull(res["last_inference_ms"]),
      initMs: numOrNull(res["initialized_ms"]),
    };
  }

  async load(): Promise<void> {
    await this.client.request("load", { model: this.model });
  }

  async unload(): Promise<void> {
    await this.client.request("unload");
  }

  async query(request: QueryRequest): Promise<QueryResult> {
    const res = (await this.client.request("query", {
      source: await this.toSource(request.source),
      question: request.question,
      reasoning: request.reasoning ?? false,
      spatial_refs: request.spatialRefs,
    })) as { answer?: string; reasoning?: string };
    if (typeof res["answer"] !== "string") {
      throw new SensesError("EMPTY_RESULT", "model returned no answer", true);
    }
    return { answer: res["answer"], reasoning: res["reasoning"] };
  }

  async detect(request: DetectRequest): Promise<DetectionResult> {
    const res = (await this.client.request("detect", {
      source: await this.toSource(request.source),
      target: request.target,
    })) as { objects?: Array<Record<string, unknown>> };
    return {
      objects: Array.isArray(res["objects"])
        ? (res["objects"] as unknown as ImportedDetectedObject[])
        : [],
    };
  }

  async point(request: PointRequest): Promise<PointResult> {
    const res = (await this.client.request("point", {
      source: await this.toSource(request.source),
      target: request.target,
    })) as { points?: Array<Record<string, unknown>> };
    return {
      points: Array.isArray(res["points"])
        ? (res["points"] as unknown as ImportedPoint[])
        : [],
    };
  }

  async ocr(request: OCRRequest): Promise<OCRResult> {
    const res = (await this.client.request("ocr", {
      source: await this.toSource(request.source),
      kind: request.kind ?? "all",
    })) as { text?: string };
    return { text: res["text"] ?? "" };
  }

  async caption(request: CaptionRequest): Promise<CaptionResult> {
    const res = (await this.client.request("caption", {
      source: await this.toSource(request.source),
      length: request.length ?? "normal",
    })) as { caption?: string };
    if (typeof res["caption"] !== "string") {
      throw new SensesError("handler.no_result", "caption returned no text", true);
    }
    return { caption: res["caption"] };
  }

  async scene(request: SceneRequest): Promise<SceneResult> {
    const res = (await this.client.request("scene", {
      source: await this.toSource(request.source),
      reasoning: request.reasoning ?? false,
    })) as { scene?: string };
    if (typeof res["scene"] !== "string" || res["scene"].trim() === "") {
      throw new SensesError("handler.no_result", "scene analysis returned no text", true);
    }
    return { scene: res["scene"] };
  }

  async segment(request: SegmentRequest): Promise<SegmentResult> {
    const res = (await this.client.request("segment", {
      source: await this.toSource(request.source),
      target: request.target,
    })) as { path?: string; bbox?: SegmentResult["bbox"] };
    return { path: res["path"], bbox: res["bbox"] };
  }

  async metadata(request: MetadataRequest): Promise<MetadataResult> {
    const res = (await this.client.request("metadata", {
      source: await this.toSource(request.source),
    })) as Record<string, unknown>;
    return {
      width: num(res["width"]),
      height: num(res["height"]),
      format: str(res["format"]),
      mode: str(res["mode"]),
      bytes: numOrNull(res["bytes"]) ?? undefined,
      dpi: Array.isArray(res["dpi"])
        ? [num(res["dpi"][0]), num(res["dpi"][1])]
        : undefined,
      exif: (res["exif"] as Record<string, unknown>) ?? {},
    };
  }

  async crop(request: CropRequest): Promise<CropResult> {
    const res = (await this.client.request("crop", {
      source: await this.toSource(request.source),
      bbox: request.bbox,
    })) as { path?: string; width?: unknown; height?: unknown; bbox_px?: number[] };
    if (typeof res["path"] !== "string") {
      throw new SensesError("EMPTY_RESULT", "crop produced no file", true);
    }
    const bp = res["bbox_px"] as number[];
    return {
      path: res["path"],
      width: num(res["width"]),
      height: num(res["height"]),
      bboxPx: bp.length === 4 ? (bp as [number, number, number, number]) : [0, 0, 0, 0],
    };
  }

  async zoom(request: ZoomRequest): Promise<ZoomResult> {
    const res = (await this.client.request("zoom", {
      source: await this.toSource(request.source),
      region: request.region,
      scale: request.scale ?? 2,
      analyze: request.analyze ?? "none",
      question: request.question,
    })) as {
      path?: string;
      width?: unknown;
      height?: unknown;
      scale?: unknown;
      analysis?: { kind?: string; text?: string };
    };
    if (typeof res["path"] !== "string") {
      throw new SensesError("EMPTY_RESULT", "zoom produced no file", true);
    }
    return {
      path: res["path"],
      width: num(res["width"]),
      height: num(res["height"]),
      scale: num(res["scale"]),
      analysis: res["analysis"]
        ? {
            kind: (res["analysis"].kind as "ocr" | "caption" | "query") ?? "query",
            text: res["analysis"].text ?? "",
          }
        : undefined,
    };
  }

  async colors(request: ColorsRequest): Promise<ColorsResult> {
    const res = (await this.client.request("colors", {
      source: await this.toSource(request.source),
      region: request.region,
    })) as {
      palette?: Array<{ hex?: string; share?: unknown }>;
      buckets?: { dark?: unknown; mid?: unknown; bright?: unknown };
      avg_rgb?: number[];
    };
    return {
      palette: (res["palette"] ?? []).map((p) => ({
        hex: p.hex ?? "#000000",
        share: num(p.share),
      })),
      buckets: {
        dark: num(res["buckets"]?.dark),
        mid: num(res["buckets"]?.mid),
        bright: num(res["buckets"]?.bright),
      },
      avgRgb: (res["avg_rgb"] as number[]).slice(0, 3) as [number, number, number],
    };
  }

  async diff(request: DiffRequest): Promise<DiffResult> {
    const res = (await this.client.request("diff", {
      source: await this.toSource(request.source),
      other: await this.toSource(request.other),
      describe: request.describe ?? false,
    })) as {
      changed_pct?: unknown;
      regions?: Array<Record<string, unknown>>;
      width?: unknown;
      height?: unknown;
      description?: string;
    };
    return {
      changedPct: num(res["changed_pct"]),
      regions: (res["regions"] ?? []).map((r) => ({
        x1: num(r["x1"]),
        y1: num(r["y1"]),
        x2: num(r["x2"]),
        y2: num(r["y2"]),
      })),
      width: num(res["width"]),
      height: num(res["height"]),
      description: res["description"],
    };
  }

  async annotate(request: AnnotateRequest): Promise<AnnotateResult> {
    const res = (await this.client.request("annotate", {
      source: await this.toSource(request.source),
      boxes: request.boxes ?? [],
      points: request.points ?? [],
      color: request.color,
      label: request.label,
    })) as { path?: string; width?: unknown; height?: unknown };
    if (typeof res["path"] !== "string") {
      throw new SensesError("EMPTY_RESULT", "annotate produced no file", true);
    }
    return { path: res["path"], width: num(res["width"]), height: num(res["height"]) };
  }

  async hashSearch(request: HashSearchRequest): Promise<HashSearchResult> {
    const res = (await this.client.request("hash_search", {
      source: await this.toSource(request.source),
      dir: request.dir,
      recursive: request.recursive ?? true,
      limit: request.limit ?? 8,
    })) as { matches?: Array<Record<string, unknown>>; scanned?: unknown; limit?: unknown };
    return {
      matches: (res["matches"] ?? []).map((m) => ({
        path: str(m["path"]),
        hamming: num(m["hamming"]),
        similarity: num(m["similarity"]),
      })),
      scanned: num(res["scanned"]),
      limit: num(res["limit"]),
    };
  }

  async reverse(request: ReverseSearchRequest): Promise<ReverseSearchResult> {
    const res = (await this.client.request("reverse", {
      source: await this.toSource(request.source),
      providers: (request.providers ?? ["local", "yandex"]).join(","),
      dir: request.dir,
      recursive: request.recursive ?? true,
      limit: request.limit ?? 8,
    })) as {
      query?: string;
      results?: Array<Record<string, unknown>>;
    };
    const results = (res["results"] ?? []).map((r) => {
      if (r["provider"] === "yandex") {
        return {
          provider: "yandex" as const,
          searchUrl: str(r["search_url"]),
          matches: ((r["matches"] as Array<Record<string, unknown>>) ?? []).map((m) => ({
            url: m["url"] == null ? null : str(m["url"]),
            title: m["title"] == null ? null : str(m["title"]),
          })),
        };
      }
      return {
        provider: "local" as const,
        matches: ((r["matches"] as Array<Record<string, unknown>>) ?? []).map((m) => ({
          path: str(m["path"]),
          similarity: num(m["similarity"]),
        })),
        scanned: num(r["scanned"]),
      };
    });
    return { query: str(res["query"]), results };
  }
}

function bool(v: unknown): boolean {
  return v === true || v === "true";
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v) || 0;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : v === null || v === undefined ? null : Number(v) || null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export { SensesError };