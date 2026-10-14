import { Plugin } from "@opencode/plugin";
import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import type { SensesMessage } from "./runtime/client.js";
import { RuntimeClient } from "./runtime/client.js";
import { PhotonProvider } from "./providers/photon.js";
import { sensesTools, sensesToolDefs } from "./opencode/tools.js";
import { AttachmentInjector, isImagePart } from "./opencode/attachments.js";

export interface SensesOptions {
  enabled?: boolean;
  autoInspect?: boolean;
  python?: string;
  timeoutMs?: number;
  fetchTimeoutMs?: number;
  reverseSearch?: "auto" | "always";
}

function readOptions(options: unknown): SensesOptions {
  return ((options ?? {}) as SensesOptions) ?? {};
}

/**
 * OpenCode 1 implementation (function entrypoint).
 *
 * Kept for the V1 support window: V1 (>=1.18.29) loads it through the
 * `server` property of the default export below, older V1 releases through
 * the named `SensesPlugin` export. Do not add new V1-only behavior here —
 * implement it once in the shared provider/injector and expose it to both
 * generations.
 */
export const SensesPlugin: V1Plugin = async (input, options) => {
  const opts = readOptions(options);

  if (opts.enabled === false) {
    return { dispose: async () => {} };
  }

  const client = new RuntimeClient({
    pythonPath: opts.python,
    timeoutMs: opts.timeoutMs,
    notify: (m: SensesMessage) => {
      if (!input.client?.tui?.showToast) return;
      void input.client.tui.showToast({
        body: { title: m.title ?? "Senses", message: m.message, variant: m.variant },
      });
    },
  });
  const providerObj = new PhotonProvider(client, {
    projectDir: input.directory,
    fetchTimeoutMs: opts.fetchTimeoutMs,
  });
  const getProvider = () => providerObj;
  const injector = new AttachmentInjector(getProvider);

  const tools = sensesTools(getProvider, {
    reverseSearch: opts.reverseSearch === "always" ? "always" : "auto",
  });

  return {
    event: async ({ event }) => {
      // Analyze a clipboard/file image as soon as it's attached to a draft —
      // before the message is submitted — so `chat.message` completes fast and
      // the model never sees a blind image part. Fire-and-forget: this hook
      // must never block the TUI while the (slow) GPU analysis runs.
      if (event.type !== "message.part.updated") return;
      if (opts.autoInspect === false) return;
      const part = (event.properties as { part?: unknown })?.part;
      if (!isImagePart(part as never)) return;
      void injector.preload(part as never).catch((err) => {
        if (process.env.SENSES_DEBUG === "1") {
          process.stderr.write(`[senses] preload failed: ${(err as Error).message}\n`);
        }
      });
    },
    "chat.message": async (msgInput, msgOutput) => {
      if (opts.autoInspect === false) return;
      await injector.handle(msgInput, msgOutput);
    },
    tool: tools,
    dispose: async () => {
      await client.close();
    },
  };
};

/**
 * OpenCode 2 definition. V2 calls `setup(ctx)`; V1 (>=1.18.29) calls
 * `server(input, options)`. Spreading `Plugin.define(...)` keeps the V2 shape
 * type-checked independently of the V1 entrypoint.
 *
 * Migration map:
 * - `tool` map            -> `ctx.tool.transform(editor => editor.add(...))`
 * - `chat.message`        -> `ctx.session.hook("prompt", ...)` (mutable draft)
 * - `message.part.updated` preload -> none (no V2 equivalent; the prompt hook
 *   analyzes synchronously at admission time)
 * - `dispose()`           -> cleanup function returned by `setup`
 * - `input.directory`     -> `ctx.location.directory`
 * - `input.client.tui.showToast` -> server-side log (no TUI channel in V2)
 */
const SensesV2 = Plugin.define({
  id: "opencode-senses",
  async setup(ctx) {
    const opts = readOptions(ctx.options);

    if (opts.enabled === false) return;

    const client = new RuntimeClient({
      pythonPath: opts.python,
      timeoutMs: opts.timeoutMs,
      notify: (m: SensesMessage) => {
        if (m.variant === "error" || process.env.SENSES_DEBUG === "1") {
          process.stderr.write(`[senses] ${m.title ? `${m.title}: ` : ""}${m.message}\n`);
        }
      },
    });
    const providerObj = new PhotonProvider(client, {
      projectDir: ctx.location.directory,
      fetchTimeoutMs: opts.fetchTimeoutMs,
    });
    const getProvider = () => providerObj;
    const injector = new AttachmentInjector(getProvider);

    await ctx.tool.transform((editor) => {
      for (const def of sensesToolDefs(getProvider, {
        reverseSearch: opts.reverseSearch === "always" ? "always" : "auto",
      })) {
        editor.add(def as never);
      }
    });

    if (opts.autoInspect !== false) {
      await ctx.session.hook("prompt", async (event) => {
        try {
          await injector.handleV2Prompt(event.prompt as never);
        } catch (err) {
          if (process.env.SENSES_DEBUG === "1") {
            process.stderr.write(`[senses] prompt hook failed: ${(err as Error).message}\n`);
          }
        }
      });
    }

    return async () => {
      await client.close();
    };
  },
});

export default {
  ...SensesV2,
  server: SensesPlugin,
};
