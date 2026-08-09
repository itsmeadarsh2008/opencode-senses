import type { Plugin } from "@opencode-ai/plugin";
import type { SensesMessage } from "./runtime/client.js";
import { RuntimeClient } from "./runtime/client.js";
import { PhotonProvider } from "./providers/photon.js";
import { sensesTools } from "./opencode/tools.js";
import { AttachmentInjector } from "./opencode/attachments.js";

export const SensesPlugin: Plugin = async (input, options) => {
  const opts: {
    enabled?: boolean;
    autoInspect?: boolean;
    python?: string;
    timeoutMs?: number;
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
  const providerObj = new PhotonProvider(client, { projectDir: input.directory });
  const getProvider = () => providerObj;
  const injector = new AttachmentInjector(getProvider);

  const tools = sensesTools(getProvider);

  return {
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