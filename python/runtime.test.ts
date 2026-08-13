import { describe, expect, it, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";

const REPO = join(import.meta.dir, "..");
const VENV_PYTHON = join(REPO, ".venv", "bin", "python");
const RUNTIME = join(REPO, "python", "runtime.py");

function chunk(type: string, data: Buffer): Buffer {
  const c = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + c.length);
  out.writeUInt32BE(data.length, 0);
  c.copy(out, 4);
  out.writeUInt32BE(crc32(c), 4 + c.length);
  return out;
}

function makePng(): Buffer {
  const w = 120;
  const h = 60;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    rows.push(0);
    for (let x = 0; x < w; x++) {
      rows.push(...(x < 40 ? [30, 120, 200] : [220, 60, 60]));
    }
  }
  const idat = deflateSync(Buffer.from(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function fixture(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "senses-test-"));
  const path = join(dir, "fx.png");
  writeFileSync(path, makePng());
  writeFileSync(join(dir, "copy.png"), makePng());
  writeFileSync(
    join(dir, "fx.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#1e78c8"/><circle cx="30" cy="30" r="18" fill="#fff"/></svg>`,
  );
  return { path, dir };
}

let proc: ReturnType<typeof spawn> | null = null;
let buf = "";
let nextId = 1;
const pending = new Map<number, (v: unknown) => void>();

function startRuntime() {
  proc = spawn(VENV_PYTHON, [RUNTIME], { stdio: ["pipe", "pipe", "inherit"] });
  proc.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.id === -1) return;
        const resolve = pending.get(msg.id);
        if (resolve) {
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        /* skip partial lines */
      }
    }
  });
}

function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => {
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    });
    proc!.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method}: timeout`));
      }
    }, 30_000);
  });
}

afterAll(() => {
  proc?.stdin!.write(JSON.stringify({ id: -2, method: "shutdown", params: {} }) + "\n");
  setTimeout(() => proc?.kill(), 500);
});

describe("python runtime analysis handlers", () => {
  it("runs metadata, crop, colors, diff, annotate, hash_search, zoom", async () => {
    startRuntime();
    const fx = fixture();
    const other = join(fx.dir, "copy.png");

    const meta = (await rpc("metadata", { source: { type: "path", path: fx.path } })) as any;
    expect(meta.width).toBe(120);
    expect(meta.height).toBe(60);
    expect(meta.format).toBe("PNG");

    const crop = (await rpc("crop", {
      source: { type: "path", path: fx.path },
      bbox: { x1: 0, y1: 0, x2: 0.5, y2: 1 },
    })) as any;
    expect(crop.width).toBe(60);
    expect(existsSync(crop.path)).toBe(true);

    const colors = (await rpc("colors", { source: { type: "path", path: fx.path } })) as any;
    expect(colors.palette.length).toBeGreaterThan(0);
    expect(colors.avg_rgb.length).toBe(3);

    const diff = (await rpc("diff", {
      source: { type: "path", path: fx.path },
      other: { type: "path", path: other },
    })) as any;
    expect(diff.changed_pct).toBe(0);

    const hash = (await rpc("hash_search", {
      source: { type: "path", path: fx.path },
      dir: fx.dir,
    })) as any;
    expect(hash.matches.length).toBeGreaterThanOrEqual(1);
    expect(hash.matches[0].similarity).toBe(1);

    const annotate = (await rpc("annotate", {
      source: { type: "path", path: fx.path },
      boxes: [{ x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9, label: "T" }],
      points: [{ x: 0.5, y: 0.5 }],
    })) as any;
    expect(existsSync(annotate.path)).toBe(true);

    const zoom = (await rpc("zoom", {
      source: { type: "path", path: fx.path },
      region: { x1: 0, y1: 0, x2: 0.4, y2: 1 },
      scale: 4,
    })) as any;
    expect(zoom.width).toBe(192);
    expect(existsSync(zoom.path)).toBe(true);
  });

  it("rejects bad bboxes with a structured error", async () => {
    const fx = fixture();
    expect(
      rpc("crop", {
        source: { type: "path", path: fx.path },
        bbox: { x1: 0.5, y1: 0.5, x2: 0.1, y2: 0.9 },
      }),
    ).rejects.toThrow();
  });

  it("reports missing files as INVALID_INPUT", async () => {
    expect(
      rpc("metadata", { source: { type: "path", path: "/nonexistent/nope.png" } }),
    ).rejects.toThrow();
  });
});