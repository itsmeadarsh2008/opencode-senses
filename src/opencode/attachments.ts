import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Part, FilePart, UserMessage } from "@opencode-ai/sdk";
import type { PhotonProvider } from "../providers/photon.js";
import type { ImageSource } from "../providers/types.js";
import contextBuilder from "../core/context-builder.js";

interface ChatMessageInput {
  sessionID: string;
  agent?: string;
  model?: unknown;
  message?: UserMessage;
  parts?: Part[];
  messageID?: string;
  variant?: string;
}

interface ChatMessageOutput {
  message: UserMessage;
  parts: Part[];
}

interface InjectedEvidence {
  text: string;
  at: number;
}

/**
 * Auto-injects Senses evidence (structured scene read + caption + exact OCR)
 * whenever the user attaches an image. Runs lazily, caches per image
 * (path + mtime + size), and never raises: a failure just means no evidence
 * block is injected.
 */
export class AttachmentInjector {
  private readonly provider: () => PhotonProvider;
  private readonly cache = new Map<string, InjectedEvidence>();
  private readonly maxCache = 32;

  constructor(provider: () => PhotonProvider) {
    this.provider = provider;
  }

  async handle(input: ChatMessageInput, output: ChatMessageOutput): Promise<void> {
    const images = (output.parts ?? []).filter(isImageFilePart);
    if (images.length === 0) return;

    const blocks: string[] = [];
    for (const img of images) {
      const key = this.keyFor(img);
      let cached = this.cache.get(key);
      if (!cached) {
        cached = await this.analyze(this.sourceFor(img), key);
        if (cached) {
          if (this.cache.size >= this.maxCache) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
          }
          this.cache.set(key, cached);
        }
      }
      if (cached) blocks.push(cached.text);
    }

    if (blocks.length > 0) {
      output.parts = [...output.parts, textPart(blocks.join("\n"))];
    }
  }

  private keyFor(part: FilePart): string {
    const stat = part.url.startsWith("/") ? statSafe(part.url) : undefined;
    return createHash("sha1")
      .update(part.url)
      .update(stat ? `${stat.size}:${stat.mtimeMs}` : "")
      .digest("hex");
  }

  private sourceFor(part: FilePart): ImageSource {
    const url = part.url;
    return url.startsWith("data:") || url.includes(";base64,")
      ? { type: "data", data: url }
      : { type: "path", path: url };
  }

  private async analyze(
    source: ImageSource,
    key: string,
  ): Promise<InjectedEvidence | undefined> {
    try {
      const [cap, scene, ocr] = await Promise.all([
        this.provider().caption({ source }),
        this.provider().scene({ source }),
        this.provider().ocr({ source }),
      ]);
      const label = source.type === "path" ? source.path : "inline-image";
      const text = [
        contextBuilder.renderScene(scene, { source: label }),
        contextBuilder.renderCaption(cap, { source: label }),
        contextBuilder.renderOCR(ocr, { source: label }),
      ].join("\n");
      return { text, at: Date.now() };
    } catch (err) {
      process.stderr.write(`[senses] auto-inject failed (${key}): ${(err as Error).message}\n`);
      return undefined;
    }
  }
}

function isImageFilePart(part: Part): part is FilePart {
  return (
    part.type === "file" &&
    (part.mime.startsWith("image/") || part.mime === "application/pdf")
  );
}

function textPart(text: string): Part {
  return { type: "text", text } as Part;
}

function statSafe(p: string): { size: number; mtimeMs: number } | undefined {
  try {
    const s = statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}