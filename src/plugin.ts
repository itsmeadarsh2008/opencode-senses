import type { Plugin } from "@opencode-ai/plugin";
import type { SensesMessage } from "./runtime/client.js";
import { RuntimeClient } from "./runtime/client.js";
import { PhotonProvider } from "./providers/photon.js";
import { sensesTools } from "./opencode/tools.js";
import { AttachmentInjector, isImagePart } from "./opencode/attachments.js";

export const SensesPlugin: Plugin = async (input, options) => {
  const opts: {
    enabled?: boolean;
    autoInspect?: boolean;
    python?: string;
    timeoutMs?: number;
    fetchTimeoutMs?: number;
    reverseSearch?: "auto" | "always";
  } = (options ?? {}) as never;

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

export default SensesPlugin;