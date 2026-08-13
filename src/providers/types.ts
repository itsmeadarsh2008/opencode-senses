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

export interface MetadataRequest {
  source: ImageSource;
}

export interface MetadataResult {
  width: number;
  height: number;
  format: string;
  mode: string;
  bytes?: number;
  dpi?: [number, number] | null;
  exif: Record<string, unknown>;
}

export interface CropRequest {
  source: ImageSource;
  bbox: BBox;
}

export interface CropResult {
  path: string;
  width: number;
  height: number;
  bboxPx: [number, number, number, number];
}

export interface ZoomRequest {
  source: ImageSource;
  region?: BBox;
  scale?: number;
  analyze?: "none" | "ocr" | "caption" | "query";
  question?: string;
}

export interface ZoomResult {
  path: string;
  width: number;
  height: number;
  scale: number;
  analysis?: { kind: "ocr" | "caption" | "query"; text: string };
}

export interface ColorsRequest {
  source: ImageSource;
  region?: BBox;
}

export interface ColorsResult {
  palette: Array<{ hex: string; share: number }>;
  buckets: { dark: number; mid: number; bright: number };
  avgRgb: [number, number, number];
}

export interface DiffRequest {
  source: ImageSource;
  other: ImageSource;
  describe?: boolean;
}

export interface DiffResult {
  changedPct: number;
  regions: BBox[];
  width: number;
  height: number;
  description?: string;
}

export interface AnnotateRequest {
  source: ImageSource;
  boxes?: Array<BBox & { label?: string }>;
  points?: Array<{ x: number; y: number; label?: string }>;
  color?: string;
  label?: string;
}

export interface AnnotateResult {
  path: string;
  width: number;
  height: number;
}

export interface HashSearchRequest {
  source: ImageSource;
  dir?: string;
  recursive?: boolean;
  limit?: number;
}

export interface HashSearchResult {
  matches: Array<{ path: string; hamming: number; similarity: number }>;
  scanned: number;
  limit: number;
}

export interface ReverseSearchRequest {
  source: ImageSource;
  providers?: string[];
  dir?: string;
  recursive?: boolean;
  limit?: number;
}

export interface ReverseSearchResult {
  query: string;
  results: Array<
    | { provider: "local"; matches: Array<{ path: string; similarity: number }>; scanned: number }
    | {
        provider: "yandex";
        searchUrl: string;
        matches: Array<{ url: string | null; title: string | null }>;
      }
  >;
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
  metadata(request: MetadataRequest): Promise<MetadataResult>;
  crop(request: CropRequest): Promise<CropResult>;
  zoom(request: ZoomRequest): Promise<ZoomResult>;
  colors(request: ColorsRequest): Promise<ColorsResult>;
  diff(request: DiffRequest): Promise<DiffResult>;
  annotate(request: AnnotateRequest): Promise<AnnotateResult>;
  hashSearch(request: HashSearchRequest): Promise<HashSearchResult>;
  reverse(request: ReverseSearchRequest): Promise<ReverseSearchResult>;
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