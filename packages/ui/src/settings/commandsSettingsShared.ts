import {
  ROBINDONE_AGENT_PROVIDER,
  ROBINDONE_COMMAND_AGENT_SOURCES,
  type RobinDoneProvider,
  type CommandAgentSource,
} from "@robindone/shared";

export const COMMAND_AGENT_SOURCES = [
  ...ROBINDONE_COMMAND_AGENT_SOURCES,
] as const satisfies readonly CommandAgentSource[];

export const COMMAND_AGENT_SOURCE_META: Record<
  CommandAgentSource,
  {
    labelId: string;
    provider: RobinDoneProvider;
    pathHint: string;
  }
> = {
  robindoneAgent: {
    labelId: "settings.commands.source.robindoneAgent",
    pathHint: "~/.robindone/commands",
    provider: ROBINDONE_AGENT_PROVIDER,
  },
};
