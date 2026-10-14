import { describe, expect, it } from "bun:test";
import { sensesTools, sensesToolDefs } from "./tools.js";
import { AttachmentInjector, isV2ImageUri } from "./attachments.js";

const noGpu = () => {
  throw new Error("no gpu in test");
};

describe("v2 tool defs", () => {
  it("mirrors the v1 tool map (names + count)", () => {
    const v1Names = Object.keys(sensesTools(noGpu as never)).sort();
    const v2Names = sensesToolDefs(noGpu as never).map((t) => t.name).sort();
    expect(v2Names).toEqual(v1Names);
    expect(v2Names).toHaveLength(13);
  });

  it("uses JSON Schema object inputs and structured executes", () => {
    for (const def of sensesToolDefs(noGpu as never)) {
      expect(def.input?.type).toBe("object");
      expect(typeof def.input.properties).toBe("object");
      expect(typeof def.execute).toBe("function");
    }
  });

  it("returns structured failures without throwing (no runtime)", async () => {
    const defs = sensesToolDefs(noGpu as never);
    const status = defs.find((t) => t.name === "senses_status");
    const out = await status!.execute({});
    expect(out.content).toContain("SENSES_ERROR");
  });
});

describe("isV2ImageUri", () => {
  it("accepts data:, file://, local paths with image exts, and remote URLs", () => {
    expect(isV2ImageUri("data:image/png;base64,abc")).toBe(true);
    expect(isV2ImageUri("data:application/pdf;base64,abc")).toBe(true);
    expect(isV2ImageUri("file:///tmp/a.png")).toBe(true);
    expect(isV2ImageUri("/tmp/a.jpg")).toBe(true);
    expect(isV2ImageUri("https://x.com/img")).toBe(true);
  });

  it("rejects non-image attachments", () => {
    expect(isV2ImageUri("notes.md")).toBe(false);
    expect(isV2ImageUri("file:///tmp/notes.txt")).toBe(false);
    expect(isV2ImageUri("data:text/plain;base64,abc")).toBe(false);
  });
});

describe("handleV2Prompt", () => {
  it("ignores prompts without images and never throws", async () => {
    const inj = new AttachmentInjector(noGpu as never);
    const prompt = { text: "hello", files: [{ uri: "notes.md" }] };
    await inj.handleV2Prompt(prompt);
    expect(prompt.text).toBe("hello");
  });

  it("is idempotent when evidence is already present", async () => {
    const inj = new AttachmentInjector(noGpu as never);
    const prompt = { text: "hi <SENSES Atlas> old", files: [{ uri: "a.png" }] };
    await inj.handleV2Prompt(prompt);
    expect(prompt.text).toBe("hi <SENSES Atlas> old");
  });
});
