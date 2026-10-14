import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import type { Part, FilePart, UserMessage } from "@opencode-ai/sdk";
import type { PhotonProvider } from "../providers/photon.js";
import type { ImageSource } from "../providers/types.js";
import contextBuilder from "../core/context-builder.js";
import { SensesError } from "../runtime/client.js";

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
  warn?: string;
  at: number;
}

/**
 * Auto-injects Senses evidence (structured scene read + caption + exact OCR)
 * whenever the user attaches an image. Clipboard images arrive as base64 data
 * URLs inside OpenCode's message store (never written to disk), so this
 * materializes them to a temp file the coding model can reference, caches
 * analysis per image (path + mtime + size), and never raises: a failure just
 * means no evidence block is injected.
 */
export class AttachmentInjector {
  private readonly provider: () => PhotonProvider;
  private readonly cache = new Map<string, InjectedEvidence>();
  private readonly inflight = new Map<string, Promise<InjectedEvidence | undefined>>();
  private readonly maxCache = 32;

  constructor(provider: () => PhotonProvider) {
    this.provider = provider;
  }

  async handle(input: ChatMessageInput, output: ChatMessageOutput): Promise<void> {
    // Idempotency: chat.message can fire twice for the same message (retry,
    // session restore, or TUI optimistic update). If we already injected, skip.
    if ((output.parts ?? []).some((p) => p.type === "text" && typeof (p as { text?: string }).text === "string" && (p as { text: string }).text.includes("<SENSES Atlas>"))) {
      return;
    }
    const rawImages = (output.parts ?? []).filter(isImageFilePart);
    if (rawImages.length === 0) return;
    // Deduplicate identical pastes (same data URL / same file path can appear
    // twice when the TUI replays history on session start).
    const seenKeys = new Set<string>();
    const images: FilePart[] = [];
    for (const img of rawImages) {
      const k = this.keyFor(img);
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      images.push(img);
    }

    // Never block message submission on the GPU. Use cached evidence if the
    // paste-time preload already finished; otherwise kick it off and inject
    // whatever is available now (path hint + any partial evidence).
    const blocks: string[] = [];
    const notes: string[] = [];
    const warnings: string[] = [];
    for (const img of images) {
      const key = this.keyFor(img);
      let record = this.cache.get(key) ?? undefined;
      if (!record) {
        // The paste-time preload (`event` hook) usually has analysis in flight
        // by the time the user submits. Give it a short bounded grace period so
        // fast submitters still get real evidence; never await the full GPU run.
        record = await Promise.race([
          this.readiness(img),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000)),
        ]);
        if (record) {
          this.cache.set(key, record);
          if (this.cache.size >= this.maxCache) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
          }
        }
      }
      if (record?.text) blocks.push(record.text);
      if (record?.warn) warnings.push(record.warn);
      const materialized = this.materialize(img, key);
      if (materialized.path) notes.push(materialized.path);
    }

    const extra: string[] = [];
    if (blocks.length > 0) extra.push(blocks.join("\n"));
    // Always tell the model where the pasted images live on disk, even if the
    // GPU analysis failed or is still running — it can re-inspect them.
    if (notes.length > 0) {
      extra.push(
        "\n<SENSES Atlas>\nPasted/clipboard images were materialized to disk so you can inspect them directly:\n" +
          notes.map((n) => `- ${n}\n`).join("") +
          "Use senses_inspect / senses_ocr / senses_detect with the path above if you need a closer look.\n</SENSES>\n",
      );
    }
    if (warnings.length > 0) {
      extra.push("\n<SENSES Notice>\n" + warnings.join("\n") + "\n</SENSES>\n");
    }

    if (extra.length > 0) {
      // IMPORTANT: opencode's chat.message hook only persists mutations to the
      // passed-in parts array (it recomputes `parts` from the same array after
      // the hook resolves). Reassigning `output.parts` is silently dropped, so
      // we must push in place. The part must also be fully-formed (id prefixed
      // "prt", matching sessionID + messageID) or opencode rejects the message.
      output.parts.push({
        id: "prt_" + createHash("sha1").update(`${output.message.id}:${Date.now()}:${extra.length}`).digest("hex").slice(0, 26),
        sessionID: output.message.sessionID ?? input.sessionID,
        messageID: output.message.id,
        type: "text",
        text: extra.join("\n"),
      } as Part);
    }
  }

  /**
   * Kick off analysis for an image part (e.g. clipboard paste) as soon as it
   * exists, without waiting for the message to be submitted. Returns the
   * cached evidence (if already resolved) for early injection.
   */
  async preload(part: FilePart): Promise<InjectedEvidence | undefined> {
    return this.readiness(part);
  }

  /**
   * V2 prompt-hook handler: analyze attached images and append evidence to
   * `prompt.text` in place. Idempotent (skips when evidence is already
   * present), deduplicates identical URIs, and never throws.
   */
  async handleV2Prompt(prompt: V2Prompt): Promise<void> {
    if (typeof prompt.text === "string" && prompt.text.includes("<SENSES Atlas>")) {
      return;
    }
    const files = (prompt.files ?? []).filter((f) => typeof f?.uri === "string" && isV2ImageUri(f.uri));
    if (files.length === 0) return;

    const seen = new Set<string>();
    const unique: V2PromptFile[] = [];
    for (const f of files) {
      const k = this.keyForUri(f.uri);
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(f);
    }

    const blocks: string[] = [];
    const notes: string[] = [];
    const warnings: string[] = [];
    for (const f of unique) {
      const key = this.keyForUri(f.uri);
      let record = this.cache.get(key) ?? undefined;
      if (!record) {
        record = (await this.analyzeUri(f.uri, key)) ?? undefined;
        if (record) {
          this.cache.set(key, record);
          if (this.cache.size >= this.maxCache) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
          }
        }
      }
      if (record?.text) blocks.push(record.text);
      if (record?.warn) warnings.push(record.warn);
      const materialized = this.materializeUri(f.uri, key);
      if (materialized.path) notes.push(materialized.path);
      else if (materialized.source.type === "path") notes.push(materialized.source.path);
    }

    const extra: string[] = [];
    if (blocks.length > 0) extra.push(blocks.join("\n"));
    if (notes.length > 0) {
      extra.push(
        "\n<SENSES Atlas>\nPasted/clipboard images were materialized to disk so you can inspect them directly:\n" +
          notes.map((n) => `- ${n}\n`).join("") +
          "Use senses_inspect / senses_ocr / senses_detect with the path above if you need a closer look.\n</SENSES>\n",
      );
    }
    if (warnings.length > 0) {
      extra.push("\n<SENSES Notice>\n" + warnings.join("\n") + "\n</SENSES>\n");
    }
    if (extra.length > 0) {
      prompt.text = `${prompt.text}\n${extra.join("\n")}`;
    }
  }

  private keyForUri(uri: string): string {
    const local = uriToLocalPath(uri);
    const stat = local ? statSafe(local) : undefined;
    return createHash("sha1")
      .update(uri)
      .update(stat ? `${stat.size}:${stat.mtimeMs}` : "")
      .digest("hex");
  }

  private materializeUri(uri: string, key: string): { source: ImageSource; path?: string } {
    const local = uriToLocalPath(uri);
    if (local) return { source: { type: "path", path: resolvePath(local) } };
    if (/^https?:\/\//i.test(uri)) return { source: { type: "path", path: uri } };
    if (uri.startsWith("data:")) {
      const comma = uri.indexOf(",");
      const head = comma >= 0 ? uri.slice(0, comma) : uri;
      const b64 = comma >= 0 ? uri.slice(comma + 1) : "";
      if (!b64) return { source: { type: "data", data: uri } };
      const mime = /data:([^;,]+)/.exec(head)?.[1] ?? "image/png";
      const ext = mimeExt(mime);
      const file = joinPath(tmpdir(), `senses-${key}.${ext}`);
      try {
        writeFileSync(file, Buffer.from(b64, "base64"));
        return { source: { type: "path", path: file }, path: file };
      } catch (err) {
        if (process.env.SENSES_DEBUG === "1") {
          process.stderr.write(`[senses] couldn't materialize paste to ${file}: ${(err as Error).message}\n`);
        }
        return { source: { type: "data", data: uri } };
      }
    }
    return { source: { type: "path", path: resolvePath(uri) } };
  }

  private async analyzeUri(uri: string, key: string): Promise<InjectedEvidence | undefined> {
    const materialized = this.materializeUri(uri, key);
    const evidence = await this.analyze(materialized.source, key);
    if (evidence) {
      const record = evidence.text
        ? evidence
        : { ...evidence, warn: (evidence.warn ?? "No textual evidence could be produced for this image.") };
      if (this.cache.size >= this.maxCache) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(key, record);
      return record;
    }
    return undefined;
  }

  /** Cache-backed analyze: warm the entry if missing, then return it. */
  private async readiness(part: FilePart): Promise<InjectedEvidence | undefined> {
    const key = this.keyFor(part);
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Deduplicate concurrent analysis of the same image (the paste fires many
    // message.part.updated events; only the first should hit the GPU).
    const inFlight = this.inflight.get(key);
    if (inFlight) return inFlight;

    const pending = this.analyzePart(part, key).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, pending);
    return pending;
  }

  private async analyzePart(
    part: FilePart,
    key: string,
  ): Promise<InjectedEvidence | undefined> {
    const materialized = this.materialize(part, key);
    const evidence = await this.analyze(materialized.source, key);
    if (evidence) {
      const record = evidence.text
        ? evidence
        : { ...evidence, warn: (evidence.warn ?? "No textual evidence could be produced for this image.") };
      if (this.cache.size >= this.maxCache) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(key, record);
      return record;
    }
    return undefined;
  }

  private keyFor(part: FilePart): string {
    const stat = part.url.startsWith("/") ? statSafe(part.url) : undefined;
    return createHash("sha1")
      .update(part.url)
      .update(stat ? `${stat.size}:${stat.mtimeMs}` : "")
      .digest("hex");
  }

  /** Filesystem path (or undefined for plain file URLs). */
  private filePath(part: FilePart): string | undefined {
    const url = part.url;
    if (url.startsWith("data:") || url.includes(";base64,")) return undefined;
    return url;
  }

  /**
   * Clipboard images come as base64 data URLs that never touch disk, so the
   * coding model (text-only) can't reference them. Write them to the OS temp
   * dir as `<sha>.png` so tool calls can use a real path.
   */
  private materialize(
    part: FilePart,
    key: string,
  ): { source: ImageSource; path?: string } {
    const existing = this.filePath(part);
    if (existing) return { source: { type: "path", path: resolvePath(existing) } };

    const b64 = part.url.includes(",") ? part.url.split(",", 2)[1] : part.url;
    if (!b64) return { source: { type: "data", data: part.url } };
    const data = Buffer.from(b64, "base64");
    const ext = mimeExt(part.mime);
    const file = joinPath(tmpdir(), `senses-${key}.${ext}`);
    try {
      writeFileSync(file, data);
      return { source: { type: "path", path: file }, path: file };
    } catch (err) {
      if (process.env.SENSES_DEBUG === "1") {
        process.stderr.write(`[senses] couldn't materialize paste to ${file}: ${(err as Error).message}\n`);
      }
      return { source: { type: "data", data: part.url } };
    }
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
      if (process.env.SENSES_DEBUG === "1") {
        process.stderr.write(`[senses] auto-inject failed (${key}): ${(err as Error).message}\n`);
      }
      const msg = (err as Error)?.message ?? String(err);
      return {
        text: "",
        warn: `Automatic vision analysis could not run right now: ${msg}. ` +
          "The image is materialized to a path below — use senses_inspect(path=...) to analyze it manually.",
        at: Date.now(),
      };
    }
  }
}

/**
 * V2 prompt-hook file attachment (OpenCode 2 `PromptInput.FileAttachment`).
 * Unlike V1 `FilePart` there is no `mime` field — the type is inferred from
 * the URI (data: prefix, file extension, or remote URL).
 */
export interface V2PromptFile {
  uri: string;
  name?: string;
  description?: string;
  mention?: { start: number; end: number; text: string };
}

export interface V2Prompt {
  text: string;
  files?: V2PromptFile[];
}

/**
 * V2 (OpenCode 2) prompt-hook entrypoint.
 *
 * V1 injected evidence by pushing a text `Part` onto `chat.message` output
 * parts. V2's `session.hook("prompt")` hands us a single mutable draft
 * instead, so evidence is appended to `prompt.text` in place. File
 * attachments arrive as `{ uri }` (file://, data:, http(s), or plain path)
 * rather than V1 `FilePart`s.
 *
 * There is no V2 equivalent of V1's `message.part.updated` paste-time
 * preload, so analysis runs synchronously here at admission time. Failures
 * never throw: the image path is still surfaced so the model can inspect it
 * manually with senses_inspect().
 */
const V2_IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "avif",
  "tiff",
  "tif",
  "heic",
  "heif",
  "svg",
  "pdf",
]);

export function isV2ImageUri(uri: string): boolean {
  if (uri.startsWith("data:")) {
    const head = uri.slice(0, 64).toLowerCase();
    return head.includes("image/") || head.includes("application/pdf");
  }
  const clean = uri.split(/[?#]/, 1)[0] ?? uri;
  const noScheme = clean.replace(/^file:\/\//, "");
  const m = /\.([a-z0-9]+)$/i.exec(noScheme);
  if (m?.[1] && V2_IMAGE_EXTS.has(m[1].toLowerCase())) return true;
  // Remote URLs without an image extension (signed URLs, CDN handlers):
  // let them through — PhotonProvider rejects non-images with NOT_AN_IMAGE.
  if (/^https?:\/\//i.test(uri)) return true;
  return false;
}
function isImageFilePart(part: Part): part is FilePart {
  return (
    part.type === "file" &&
    (part.mime.startsWith("image/") || part.mime === "application/pdf")
  );
}

export function isImagePart(part: Part): part is FilePart {
  return isImageFilePart(part);
}

function statSafe(p: string): { size: number; mtimeMs: number } | undefined {
  try {
    const s = statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "application/pdf": "pdf",
};

function mimeExt(mime: string): string {
  return MIME_EXT[mime] ?? "png";
}

/** Strip file:// to a local path; undefined for data:/http(s):/bare-relative URIs handled elsewhere. */
function uriToLocalPath(uri: string): string | undefined {
  if (uri.startsWith("file://")) {
    try {
      return decodeURIComponent(uri.replace(/^file:\/\//, ""));
    } catch {
      return uri.replace(/^file:\/\//, "");
    }
  }
  if (/^(data|https?):/i.test(uri)) return undefined;
  return uri;
}