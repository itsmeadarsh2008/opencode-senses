import { tool } from "@opencode-ai/plugin";
import type { PhotonProvider } from "../providers/photon.js";
import type { VisionHealth, ImageSource, BBox } from "../providers/types.js";
import contextBuilder from "../core/context-builder.js";
import { SensesError } from "../runtime/client.js";

/** Resolve an image source from a tool arg; throws a SensesError on bad input. */
function makeImageSource(
  path: string | undefined,
  image: string | undefined,
): ImageSource {
  if (image) return { type: "data", data: image };
  if (path) return { type: "path", path };
  throw new SensesError("INVALID_INPUT", "must provide either 'path' or 'image'");
}

function sourceLabel(args: { path?: string }): string {
  return args.path ?? "inline-image";
}

/** Wrap tool errors so the coding model sees structured failures. */
function fail(err: unknown): string {
  const isSenses = err instanceof SensesError;
  // find outermost error introduced by the runtime
  let message = (err as Error).message;
  return `SENSES_ERROR (${isSenses ? (err as SensesError).code : "UNKNOWN"}): ${message}\n\nThe image could not be analyzed. Report this to the user plainly.`;
}

export function sensesTools(
  provider: () => PhotonProvider,
  opts: { reverseSearch?: "auto" | "always" } = {},
) {
  const reverseAlways = opts.reverseSearch === "always";

  return {
    "senses_inspect": tool({
      description:
        "Inspect an image with the Senses vision model. Use for screenshots, attached media, or design mockups. If 'question' is given, answers it; otherwise returns a structured scene read (image type, layout, elements, state) plus a caption and exact OCR of any visible text. Returns structured evidence in <SENSES> tags.",
      args: {
        path: tool.schema.string().optional().describe("Path to the image file, relative to the current project."),
        image: tool.schema.string().optional().describe("Image as a base64 data URL (data:image/...;base64,...)."),
        question: tool.schema.string().optional().describe("Natural-language question about the image."),
      },
      execute: async (args) => {
        try {
          const src = makeImageSource(args.path, args.image);
          const label = sourceLabel(args);
          if (args.question) {
            const res = await provider().query({ source: src, question: args.question });
            return contextBuilder.renderQuery(res, { source: label, question: args.question });
          }
          const [cap, scene, ocr, localMatch] = await Promise.all([
            provider().caption({ source: src }),
            provider().scene({ source: src }),
            provider().ocr({ source: src }),
            reverseAlways
              ? provider()
                  .hashSearch({ source: src })
                  .then((r) => (r.matches.length ? r : null))
                  .catch(() => null)
              : Promise.resolve(null),
          ]);
          const parts = [
            contextBuilder.renderScene(scene, { source: label }),
            contextBuilder.renderCaption(cap, { source: label }),
            contextBuilder.renderOCR(ocr, { source: label }),
          ];
          if (localMatch) {
            parts.push(
              contextBuilder.renderReverse({
                query: label,
                results: [
                  {
                    provider: "local",
                    matches: localMatch.matches.map((m) => ({
                      path: m.path,
                      similarity: m.similarity,
                    })),
                    scanned: localMatch.scanned,
                  },
                ],
              }),
            );
          }
          return parts.join("\n");
        } catch (err) {
          return fail(err);
        }
      },
    }),

    "senses_detect": tool({
      description:
        "Detect objects or UI elements in an image and return their labeled bounding boxes (e.g. 'submit button', 'navbar', 'broken element').",
      args: {
        path: tool.schema.string().optional().describe("Path to the image file."),
        image: tool.schema.string().optional().describe("Image as a base64 data URL."),
        target: tool.schema.string().describe("The object or UI element to search for."),
      },
      execute: async (args) => {
        try {
          const src = makeImageSource(args.path, args.image);
          const res = await provider().detect({ source: src, target: args.target });
          return contextBuilder.renderDetection(res, {
            source: sourceLabel(args),
            title: `Detect:${args.target}`,
          });
        } catch (err) {
          return fail(err);
        }
      },
    }),

    "senses_point": tool({
      description:
        "Locate the exact on-screen position of a target in an image. Returns normalized point coordinates (0-1) identifying where the target sits.",
      args: {
        path: tool.schema.string().optional().describe("Path of the image file."),
        image: tool.schema.string().optional().describe("Image as a base64 data URL."),
        target: tool.schema.string().describe("The object or element to locate."),
      },
      execute: async (args) => {
        try {
          const src = makeImageSource(args.path, args.image);
          const res = await provider().point({ source: src, target: args.target });
          return contextBuilder.renderPoint(res, { source: sourceLabel(args) });
        } catch (err) {
          return fail(err);
        }
      },
    }),

    "senses_ocr": tool({
      description:
        "Extract exact text from an image. Prefer this over a caption when the precise wording of an error message, code, label, or page text matters.",
      args: {
        path: tool.schema.string().optional().describe("Path of the image file."),
        image: tool.schema.string().optional().describe("Image as a base64 data URL."),
        kind: tool.schema
          .enum(["all", "code", "error"])
          .optional()
          .describe("'all' transcribes everything; 'code' targets code text; 'error' targets error messages."),
      },
      execute: async (args) => {
        try {
          const src = makeImageSource(args.path, args.image);
          const kindArg = args.kind ?? "all";
          const res = await provider().ocr({ source: src, kind: kindArg });
          return contextBuilder.renderOCR(res, { source: sourceLabel(args) });
        } catch (err) {
          return fail(err);
        }
      },
    }),

    "senses_status": tool({
      description:
        "Report the Senses vision runtime status: model load state, device, VRAM usage, request count, last inference time.",
      args: {},
      execute: async () => {
        try {
          const health: VisionHealth = await provider().health();
          return contextBuilder.renderHealth(health);
        } catch (err) {
          return fail(err);
        }
      },
    }),

    "senses_segment": tool({
      description:
        "Cut out an object or UI element from an image. Returns the path to a saved mask/PNG plus its bounding box. Use when you need a clean region of an image (logo, button, person, chart element) rather than just coordinates.",
      args: {
        path: tool.schema.string().optional().describe("Path or http(s) URL of the image file."),
        image: tool.schema.string().optional().describe("Image as a base64 data URL."),
        target: tool.schema.string().describe("The object or element to segment."),
      },
      execute: async (args) => {
        try {
          const src = makeImageSource(args.path, args.image);
          const res = await provider().segment({ source: src, target: args.target });
          return contextBuilder.renderSegment(res, {
            source: sourceLabel(args),
            title: `Segment:${args.target}`,
          });
        } catch (err) {
          return fail(err);
        }
      },
    }),

    "senses_metadata": tool({
      description:
        "Read image metadata without any model: dimensions, format, mode, byte size, DPI, EXIF. Use to verify a file (including web-downloaded images) kept its real type and size, or to debug rendering issues.",
      args: {
        path: tool.schema.string().optional().describe("Path or http(s) URL of the image file."),
        image: tool.schema.string().optional().describe("Image as a base64 data URL."),
      },
      execute: async (args) => {
        try {
          const src = makeImageSource(args.path, args.image);
          const res = await provider().metadata({ source: src });
          return contextBuilder.renderMetadata(res, { source: sourceLabel(args) });
        } catch (err) {
          return fail(err);
        }
      },
    }),

    "senses_crop": tool({
      description:
        "Crop a region of an image and save it to disk. Region is a normalized bbox (0-1) in the same shape as senses_detect output: [x1, y1, x2, y2]. Returns the saved file path — feed it back into any other senses_* tool.",
      args: {
        path: tool.schema.string().optional().describe("Path or http(s) URL of the image file."),
        image: tool.schema.string().optional().describe("Image as a base64 data URL."),
        bbox: tool.schema
          .string()
          .describe("Normalized [x1, y1, x2, y2] comma-separated, e.g. '0.2,0.3,0.6,0.7'."),
      },
      execute: async (args) => {
        try {
          const src = makeImageSource(args.path, args.image);
          const bbox = parseBBox(args.bbox);
          const res = await provider().crop({ source: src, bbox });
          return contextBuilder.renderCrop(res, { source: sourceLabel(args) });
        } catch (err) {
          return fail(err);
        }
      },
    }),

    "senses_zoom": tool({
      description:
        "Upscale a region (or the whole image) with LANCZOS and optionally re-analyze it with the model. Small text or fine details that the vision model misses at full-image scale become readable after zooming. 'region' defaults to the whole image.",
      args: {
        path: tool.schema.string().optional().describe("Path or http(s) URL of the image file."),
        image: tool.schema.string().optional().describe("Image as a base64 data URL."),
        region: tool.schema
          .string()
          .optional()
          .describe("Optional normalized [x1, y1, x2, y2] comma-separated."),
        scale: tool.schema
          .number()
          .optional()
          .describe("Upscale factor, 1-8 (default 2)."),
        analyze: tool.schema
          .enum(["none", "ocr", "caption", "query"])
          .optional()
          .describe("Re-analyze the upscaled crop: 'ocr' reads its text, 'caption' describes it, 'query' answers a question (default 'none')."),
        question: tool.schema
          .string()
          .optional()
          .describe("Required when analyze='query'."),
      },
      execute: async (args) => {
        try {
          const src = makeImageSource(args.path, args.image);
          const res = await provider().zoom({
            source: src,
            region: args.region ? parseBBox(args.region) : undefined,
            scale: args.scale ?? 2,
            analyze: args.analyze ?? "none",
            question: args.question,
          });
          return contextBuilder.renderZoom(res, { source: sourceLabel(args) });
        } catch (err) {
          return fail(err);
        }
      },
    }),

    "senses_colors": tool({
      description:
        "Deterministic color analysis (no model): dominant palette with shares, dark/mid/bright luminance buckets, and average RGB for an image or region. Use for ground-truth checks the vision model can't do reliably.",
      args: {
        path: tool.schema.string().optional().describe("Path or http(s) URL of the image file."),
        image: tool.schema.string().optional().describe("Image as a base64 data URL."),
        region: tool.schema
          .string()
          .optional()
          .describe("Optional normalized [x1, y1, x2, y2] comma-separated."),
      },
      execute: async (args) => {
        try {
          const src = makeImageSource(args.path, args.image);
          const res = await provider().colors({
            source: src,
            region: args.region ? parseBBox(args.region) : undefined,
          });
          return contextBuilder.renderColors(res, { source: sourceLabel(args) });
        } catch (err) {
          return fail(err);
        }
      },
    }),

    "senses_diff": tool({
      description:
        "Pixel-level comparison of two images: percent changed and the changed-region bounding boxes (anti-aliasing is blurred out). Optionally ask the model to describe what changed via 'describe'. Pass the second image in 'otherPath' (or 'otherImage').",
      args: {
        path: tool.schema.string().optional().describe("First image: path or http(s) URL."),
        image: tool.schema.string().optional().describe("First image as a base64 data URL."),
        otherPath: tool.schema
          .string()
          .optional()
          .describe("Second image: path or http(s) URL."),
        otherImage: tool.schema
          .string()
          .optional()
          .describe("Second image as a base64 data URL."),
        describe: tool.schema
          .boolean()
          .optional()
          .describe("Run the vision model on the diff and summarize what changed."),
      },
      execute: async (args) => {
        try {
          const src = makeImageSource(args.path, args.image);
          const other = makeImageSource(args.otherPath, args.otherImage);
          const res = await provider().diff({
            source: src,
            other,
            describe: args.describe ?? false,
          });
          return contextBuilder.renderDiff(res, {
            source: sourceLabel(args),
            other: args.otherPath ?? "inline-image",
          });
        } catch (err) {
          return fail(err);
        }
      },
    }),

    "senses_annotate": tool({
      description:
        "Draw bounding boxes and/or points onto an image and save a copy. Takes the same shapes as senses_detect/senses_point output so you can visually validate what the model found. Returns the annotated file path.",
      args: {
        path: tool.schema.string().optional().describe("Path or http(s) URL of the image file."),
        image: tool.schema.string().optional().describe("Image as a base64 data URL."),
        boxes: tool.schema
          .string()
          .optional()
          .describe("JSON array of {x1,y1,x2,y2,label?} normalized boxes."),
        points: tool.schema
          .string()
          .optional()
          .describe("JSON array of {x,y,label?} normalized points."),
        color: tool.schema
          .string()
          .optional()
          .describe("Stroke color for boxes/points, e.g. '#ff3355'."),
        label: tool.schema.string().optional().describe("Default label for all boxes/points."),
      },
      execute: async (args) => {
        try {
          const src = makeImageSource(args.path, args.image);
          const res = await provider().annotate({
            source: src,
            boxes: args.boxes ? (JSON.parse(args.boxes) as Array<BBox & { label?: string }>) : [],
            points: args.points
              ? (JSON.parse(args.points) as Array<{ x: number; y: number; label?: string }>)
              : [],
            color: args.color,
            label: args.label,
          });
          return contextBuilder.renderAnnotate(res, { source: sourceLabel(args) });
        } catch (err) {
          return fail(err);
        }
      },
    }),

    "senses_reverse": tool({
      description:
        "Reverse image search with no API key. 'local' perceptual-hash search finds near-duplicates in your cache and optional 'dir' (always available); 'yandex' uploads to Yandex image search and returns matching page URLs. Default providers: local,yandex.",
      args: {
        path: tool.schema.string().optional().describe("Path or http(s) URL of the image file."),
        image: tool.schema.string().optional().describe("Image as a base64 data URL."),
        providers: tool.schema
          .string()
          .optional()
          .describe("Comma-separated: 'local', 'yandex' (default 'local,yandex')."),
        dir: tool.schema
          .string()
          .optional()
          .describe("Directory to scan for local matches (default: senses cache)."),
        limit: tool.schema
          .number()
          .optional()
          .describe("Max local matches (1-25, default 8)."),
      },
      execute: async (args) => {
        try {
          const src = makeImageSource(args.path, args.image);
          const res = await provider().reverse({
            source: src,
            providers: args.providers ? args.providers.split(",").map((p) => p.trim()) : undefined,
            dir: args.dir,
            limit: args.limit,
          });
          return contextBuilder.renderReverse(res);
        } catch (err) {
          return fail(err);
        }
      },
    }),
  } as const;
}

export function parseBBox(s: string): BBox {
  const parts = s.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) {
    throw new SensesError("INVALID_INPUT", `invalid bbox '${s}' — expected 'x1,y1,x2,y2'`);
  }
  const [x1, y1, x2, y2] = parts as [number, number, number, number];
  if (x2 <= x1 || y2 <= y1) {
    throw new SensesError("INVALID_INPUT", `invalid bbox '${s}' — x2/x1 and y2/y1 must be ordered`);
  }
  return { x1, y1, x2, y2 };
}