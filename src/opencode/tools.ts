import { tool } from "@opencode-ai/plugin";
import type { PhotonProvider } from "../providers/photon.js";
import type { VisionHealth, ImageSource } from "../providers/types.js";
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

export function sensesTools(provider: () => PhotonProvider) {
  return {
    "senses.inspect": tool({
      description:
        "Inspect an image with the Senses vision model (Moondream 3.1). Use for screenshots, attached media, or design mockups. If 'question' is given, answers it; otherwise returns a caption plus exact OCR of any visible text. Returns structured evidence in <SENSES> tags.",
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
          const [cap, ocr] = await Promise.all([
            provider().caption({ source: src }),
            provider().ocr({ source: src }),
          ]);
          return [
            contextBuilder.renderCaption(cap, { source: label }),
            contextBuilder.renderOCR(ocr, { source: label }),
          ].join("\n");
        } catch (err) {
          return fail(err);
        }
      },
    }),

    "senses.detect": tool({
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

    "senses.point": tool({
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

    "senses.ocr": tool({
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

    "senses.status": tool({
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
  } as const;
}