import { describe, expect, it } from "bun:test";
import { extForContentType } from "./photon.js";
import { parseBBox } from "../opencode/tools.js";
import { SensesError } from "../runtime/client.js";

describe("extForContentType", () => {
  it("maps known content types to their extension", () => {
    expect(extForContentType("image/jpeg", "https://x.com/img")).toBe("jpg");
    expect(extForContentType("image/png", "https://x.com/img")).toBe("png");
    expect(extForContentType("image/svg+xml; charset=utf-8", "https://x.com/i.svg")).toBe("svg");
    expect(extForContentType("image/heic", "https://x.com/p")).toBe("heic");
  });

  it("falls back to the URL extension when content type is unknown", () => {
    expect(extForContentType("application/octet-stream", "https://x.com/a/photo.webp")).toBe("webp");
    expect(extForContentType("", "https://x.com/b.png?w=200")).toBe("png");
  });

  it("defaults to .img when nothing matches", () => {
    expect(extForContentType("application/pdf", "https://x.com/file")).toBe("img");
    expect(extForContentType("", "https://x.com/")).toBe("img");
  });
});

describe("parseBBox", () => {
  it("parses normalized comma-separated bboxes", () => {
    expect(parseBBox("0.2,0.3,0.6,0.7")).toEqual({ x1: 0.2, y1: 0.3, x2: 0.6, y2: 0.7 });
  });

  it("rejects malformed input", () => {
    expect(() => parseBBox("1,2")).toThrow(SensesError);
    expect(() => parseBBox("a,b,c,d")).toThrow(SensesError);
    expect(() => parseBBox("0.5,0.5,0.2,0.7")).toThrow(SensesError);
  });
});
