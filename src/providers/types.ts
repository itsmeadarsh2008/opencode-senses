export type Modality = "image" | "audio" | "video" | "document";

export type EvidenceType =
  | "text"
  | "object"
  | "region"
  | "event"
  | "table"
  | "relationship"
  | "transcription";

export type EvidenceStatus = "observed" | "inferred" | "verified" | "uncertain" | "contradictory";

export interface BBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DetectedObject {
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  confidence: number;
}

export interface Point {
  x: number;
  y: number;
  confidence: number;
}

export interface SpatialReference {
  prompt: string;
  index: number;
}

export interface ProviderHealth {
  ok: boolean;
  loaded: boolean;
  device: string;
  model: string | null;

  gpu?: {
    name: string;
    totalVramGb: number;
    usedVramGb: number;
  };
  latencyMs?: number;
}

export type ImageSource =
  | { type: "path"; path: string }
  | { type: "data"; data: string };

export interface VisualQueryRequest {
  source: ImageSource;
  question: string;
  reasoning?: boolean;
  spatialRefs?: SpatialReference[];
}

export interface QueryRequest {
  source: ImageSource;
  question: string;
  reasoning?: boolean;
  spatialRefs?: SpatialReference[];
}

/** @deprecated use QueryRequest */
export type VisionQuery = QueryRequest;

export interface DetectRequest {
  source: ImageSource;
  target: string;
}

export interface PointRequest {
  source: ImageSource;
  target: string;
}

export interface OCRRequest {
  source: ImageSource;
  kind?: "all" | "code" | "error";
}

export interface CaptionRequest {
  source: ImageSource;
  length?: "short" | "normal" | "long";
}

export interface SceneRequest {
  source: ImageSource;
  reasoning?: boolean;
}

export interface SegmentRequest {
  source: ImageSource;
  target: string;
}

export interface QueryResult {
  answer: string;
  reasoning?: string;
}

export interface DetectionResult {
  objects: DetectedObject[];
}

export interface PointResult {
  points: Point[];
}

export interface OCRResult {
  text: string;
}

export interface CaptionResult {
  caption: string;
}

export interface SceneResult {
  scene: string;
}

export interface SegmentResult {
  path?: string;
  bbox?: BBox;
}

export interface Evidence {
  id: string;

  source: string;
  modality: "image" | "audio" | "video" | "document";
  type: EvidenceType;
  content: unknown;

  confidence?: number;
  status?: EvidenceStatus;
  spatial?: BBox;
  provider: string;
  model: string;
  createdAt: number;
}

export interface VisionProvider {
  readonly id: string;
  readonly model: string;

  health(): Promise<VisionHealth>;
  load(): Promise<void>;
  unload(): Promise<void>;

  query(request: QueryRequest): Promise<QueryResult>;
  detect(request: DetectRequest): Promise<DetectionResult>;
  point(request: PointRequest): Promise<PointResult>;
  ocr(request: OCRRequest): Promise<OCRResult>;
  caption(request: CaptionRequest): Promise<CaptionResult>;
  scene(request: SceneRequest): Promise<SceneResult>;
  segment(request: SegmentRequest): Promise<SegmentResult>;
}

export interface VisionHealth {
  provider: string;
  model: string | null;
  device: string;
  loaded: boolean;
  vram?: { name: string; totalGb: number; usedGb: number };
  requestCount: number;
  lastInferenceMs: number | null;
  initMs: number | null;
}