import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType, type AutocompleteInteraction } from "@buape/carbon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findCommandByNativeName,
  resolveCommandArgChoices,
} from "../../../../src/auto-reply/commands-registry.js";
import type { OpenClawConfig, loadConfig } from "../../../../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store.js";
import { resolveDiscordNativeChoiceContext } from "./native-command-ui.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const STORE_PATH = path.join(
  os.tmpdir(),
  `openclaw-discord-think-autocomplete-${process.pid}.json`,
);
const SESSION_KEY = "agent:main:main";

describe("discord native /think autocomplete", () => {
  beforeEach(() => {
    clearSessionStoreCacheForTest();
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify({
        [SESSION_KEY]: {
          updatedAt: Date.now(),
          providerOverride: "openai-codex",
          modelOverride: "gpt-5.4",
        },
      }),
      "utf8",
    );
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    try {
      fs.unlinkSync(STORE_PATH);
    } catch {}
  });

  it("uses the session override context for /think choices", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4.5",
          },
        },
      },
      session: {
        store: STORE_PATH,
      },
    } as ReturnType<typeof loadConfig>;
    const interaction = {
      options: {
        getFocused: () => ({ value: "xh" }),
      },
      respond: async (_choices: Array<{ name: string; value: string }>) => {},
      rawData: {},
      channel: { id: "D1", type: ChannelType.DM },
      user: { id: "U1" },
      guild: undefined,
      client: {},
    } as unknown as AutocompleteInteraction & {
      respond: (choices: Array<{ name: string; value: string }>) => Promise<void>;
    };

    const command = findCommandByNativeName("think", "discord");
    expect(command).toBeTruthy();
    const levelArg = command?.args?.find((entry) => entry.name === "level");
    expect(levelArg).toBeTruthy();
    if (!command || !levelArg) {
      return;
    }

    const context = await resolveDiscordNativeChoiceContext({
      interaction,
      cfg,
      accountId: "default",
      threadBindings: createNoopThreadBindingManager("default"),
    });
    expect(context).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
    });

    const choices = resolveCommandArgChoices({
      command,
      arg: levelArg,
      cfg,
      provider: context?.provider,
      model: context?.model,
    });
    const values = choices.map((choice) => choice.value);
    expect(values).toContain("xhigh");
  });
});
