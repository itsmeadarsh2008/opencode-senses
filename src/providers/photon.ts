import { resolve as resolvePath, isAbsolute } from "node:path";
import type { RuntimeClient } from "../runtime/client.js";
import { SensesError } from "../runtime/client.js";

import type {
  CaptionRequest,
  CaptionResult,
  DetectRequest,
  DetectionResult,
  ImageSource,
  OCRRequest,
  OCRResult,
  PointRequest,
  PointResult,
  QueryRequest,
  QueryResult,
  SegmentRequest,
  SegmentResult,
  VisionHealth,
  VisionProvider,
} from "./types.js";
import type { DetectedObject, Point } from "./types.js";

type ImportedDetectedObject = DetectedObject;
type ImportedPoint = Point;

/**
 * VisionProvider backed by the Senses Python runtime (Photon + Moondream 3.1).
 *
 * Calls are correlated over the stdio JSON-RPC channel. File-based image
 * sources are resolved relative to the caller's project directory so the
 * plugin stays thin and the Python side stays stateless.
 */
export class PhotonProvider implements VisionProvider {
  readonly id = "photon";
  readonly model = "moondream2";

  private readonly client: RuntimeClient;
  private readonly projectDir: string;

  constructor(client: RuntimeClient, opts: { projectDir?: string } = {}) {
    this.client = client;
    this.projectDir = opts.projectDir ?? process.cwd();
  }

  private toSource(source: ImageSource): Record<string, unknown> {
    if (source.type === "data") {
      return { type: "data", data: source.data };
    }
    const path = isAbsolute(source.path)
      ? source.path
      : resolvePath(this.projectDir, source.path);
    return { type: "path", path };
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
      source: this.toSource(request.source),
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
      source: this.toSource(request.source),
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
      source: this.toSource(request.source),
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
      source: this.toSource(request.source),
      kind: request.kind ?? "all",
    })) as { text?: string };
    return { text: res["text"] ?? "" };
  }

  async caption(request: CaptionRequest): Promise<CaptionResult> {
    const res = (await this.client.request("caption", {
      source: this.toSource(request.source),
      length: request.length ?? "normal",
    })) as { caption?: string };
    if (typeof res["caption"] !== "string") {
      throw new SensesError("handler.no_result", "caption returned no text", true);
    }
    return { caption: res["caption"] };
  }

  async segment(request: SegmentRequest): Promise<SegmentResult> {
    const res = (await this.client.request("segment", {
      source: this.toSource(request.source),
      target: request.target,
    })) as { path?: string; bbox?: SegmentResult["bbox"] };
    return { path: res["path"], bbox: res["bbox"] };
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

export { SensesError };