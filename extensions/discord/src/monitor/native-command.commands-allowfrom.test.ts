import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCommandSpec } from "../../../../src/auto-reply/commands-registry.js";
import * as dispatcherModule from "../../../../src/auto-reply/reply/provider-dispatcher.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store.js";
import type { DiscordAccountConfig } from "../../../../src/config/types.discord.js";
import * as pluginCommandsModule from "../../../../src/plugins/commands.js";
import { createDiscordNativeCommand } from "./native-command.js";
import {
  createMockCommandInteraction,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";
import { resolveDiscordBoundConversationRoute } from "./route-resolution.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const STORE_PATH = path.join(
  os.tmpdir(),
  `openclaw-discord-native-command-allowfrom-${process.pid}.json`,
);

function createInteraction(params?: { userId?: string }): MockCommandInteraction {
  return createMockCommandInteraction({
    userId: params?.userId ?? "123456789012345678",
    username: "discord-user",
    globalName: "Discord User",
    channelType: ChannelType.GuildText,
    channelId: "234567890123456789",
    guildId: "345678901234567890",
    guildName: "Test Guild",
    interactionId: "interaction-1",
  });
}

function createConfig(): OpenClawConfig {
  return {
    commands: {
      allowFrom: {
        discord: ["user:123456789012345678"],
      },
    },
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: {
          "345678901234567890": {
            channels: {
              "234567890123456789": {
                allow: true,
                requireMention: false,
              },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createCommand(cfg: OpenClawConfig, discordConfig?: DiscordAccountConfig) {
  const commandSpec: NativeCommandSpec = {
    name: "status",
    description: "Status",
    acceptsArgs: false,
  };
  return createDiscordNativeCommand({
    command: commandSpec,
    cfg,
    discordConfig: discordConfig ?? cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

function createDispatchSpy() {
  return vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({
    counts: {
      final: 1,
      block: 0,
      tool: 0,
    },
  } as never);
}

async function runGuildSlashCommand(params?: {
  userId?: string;
  mutateConfig?: (cfg: OpenClawConfig) => void;
  runtimeDiscordConfig?: DiscordAccountConfig;
}) {
  const cfg = createConfig();
  params?.mutateConfig?.(cfg);
  const command = createCommand(cfg, params?.runtimeDiscordConfig);
  const interaction = createInteraction({ userId: params?.userId });
  vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
  const dispatchSpy = createDispatchSpy();
  await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);
  return { dispatchSpy, interaction };
}

function expectNotUnauthorizedReply(interaction: MockCommandInteraction) {
  expect(interaction.reply).not.toHaveBeenCalledWith(
    expect.objectContaining({ content: "You are not authorized to use this command." }),
  );
}

function expectUnauthorizedReply(interaction: MockCommandInteraction) {
  expect(interaction.reply).toHaveBeenCalledWith(
    expect.objectContaining({
      content: "You are not authorized to use this command.",
      ephemeral: true,
    }),
  );
}

describe("Discord native slash commands with commands.allowFrom", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearSessionStoreCacheForTest();
    try {
      fs.unlinkSync(STORE_PATH);
    } catch {}
  });

  it("authorizes guild slash commands when commands.allowFrom.discord matches the sender", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectNotUnauthorizedReply(interaction);
  });

  it("authorizes guild slash commands from the global commands.allowFrom list when provider-specific allowFrom is missing", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      mutateConfig: (cfg) => {
        cfg.commands = {
          allowFrom: {
            "*": ["user:123456789012345678"],
          },
        };
      },
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectNotUnauthorizedReply(interaction);
  });

  it("authorizes guild slash commands when commands.useAccessGroups is false and commands.allowFrom.discord matches the sender", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      mutateConfig: (cfg) => {
        cfg.commands = {
          ...cfg.commands,
          useAccessGroups: false,
        };
      },
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectNotUnauthorizedReply(interaction);
  });

  it("rejects guild slash commands when commands.allowFrom.discord does not match the sender", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      userId: "999999999999999999",
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expectUnauthorizedReply(interaction);
  });

  it("rejects guild slash commands when commands.useAccessGroups is false and commands.allowFrom.discord does not match the sender", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      userId: "999999999999999999",
      mutateConfig: (cfg) => {
        cfg.commands = {
          ...cfg.commands,
          useAccessGroups: false,
        };
      },
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expectUnauthorizedReply(interaction);
  });

  it("does not expose session-derived /think choices to unauthorized guild users", async () => {
    const cfg = createConfig();
    cfg.agents = {
      defaults: {
        model: {
          primary: "anthropic/claude-sonnet-4.5",
        },
      },
    };
    cfg.session = { store: STORE_PATH };
    const route = resolveDiscordBoundConversationRoute({
      cfg,
      accountId: "default",
      guildId: "345678901234567890",
      memberRoleIds: [],
      isDirectMessage: false,
      isGroupDm: false,
      directUserId: "999999999999999999",
      conversationId: "234567890123456789",
    });
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify({
        [route.sessionKey]: {
          updatedAt: Date.now(),
          providerOverride: "openai-codex",
          modelOverride: "gpt-5.4",
        },
      }),
      "utf8",
    );

    const command = createDiscordNativeCommand({
      command: {
        name: "think",
        description: "Set thinking level.",
        acceptsArgs: true,
      },
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });
    const levelOption = command.options?.find((entry) => entry.name === "level") as
      | {
          autocomplete?: (interaction: {
            options: { getFocused: () => { value: string } };
            respond: (choices: Array<{ name: string; value: string }>) => Promise<void>;
            rawData: { member: { roles: string[] } };
            channel: { id: string; type: ChannelType };
            user: { id: string; username: string; globalName: string };
            guild: { id: string; name: string };
            client: object;
          }) => Promise<void>;
        }
      | undefined;
    expect(typeof levelOption?.autocomplete).toBe("function");
    if (typeof levelOption?.autocomplete !== "function") {
      return;
    }

    const respond = vi.fn().mockResolvedValue(undefined);
    await levelOption.autocomplete({
      options: {
        getFocused: () => ({ value: "xh" }),
      },
      respond,
      rawData: {
        member: { roles: [] },
      },
      channel: { id: "234567890123456789", type: ChannelType.GuildText },
      user: {
        id: "999999999999999999",
        username: "discord-user",
        globalName: "Discord User",
      },
      guild: { id: "345678901234567890", name: "Test Guild" },
      client: {},
    });

    const choices = respond.mock.calls[0]?.[0] ?? [];
    const values = choices.map((choice: { value: string }) => choice.value);
    expect(values).not.toContain("xhigh");
  });

  it("uses the root discord maxLinesPerMessage when runtime discordConfig omits it", async () => {
    const longReply = Array.from({ length: 20 }, (_value, index) => `Line ${index + 1}`).join("\n");
    const { interaction } = await runGuildSlashCommand({
      mutateConfig: (cfg) => {
        cfg.channels = {
          ...cfg.channels,
          discord: {
            ...cfg.channels?.discord,
            maxLinesPerMessage: 120,
          },
        };
      },
      runtimeDiscordConfig: {
        groupPolicy: "allowlist",
        guilds: {
          "345678901234567890": {
            channels: {
              "234567890123456789": {
                allow: true,
                requireMention: false,
              },
            },
          },
        },
      },
    });

    const dispatchCall = vi.mocked(dispatcherModule.dispatchReplyWithDispatcher).mock
      .calls[0]?.[0] as
      | Parameters<typeof dispatcherModule.dispatchReplyWithDispatcher>[0]
      | undefined;
    await dispatchCall?.dispatcherOptions.deliver({ text: longReply }, { kind: "final" });

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: longReply }));
    expect(interaction.followUp).not.toHaveBeenCalled();
  });
});
