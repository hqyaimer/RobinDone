import type { Model, ModelInputMessage } from "@robinrun/contracts";
import { ContextBuilder, buildMetaUserAttachments } from "../context/builder.js";
import {
  type ContextBuilderConfig,
  type ContextBuildResult,
  type ContextSection,
  type EnvInfo,
} from "../context/index.js";
import { buildCliPrefixSection } from "../context/sections/cli-prefix.js";
import { buildCurrentDateSection } from "../context/sections/current-date.js";
import { buildEnvironmentSections } from "../context/sections/env-info.js";
import {
  buildProjectInstructionsSection,
  buildRequestUserContextSection,
} from "../context/sections/request-user-context.js";
import { buildSkillsSection } from "../context/sections/skills.js";
import { estimateTokens } from "../context/utils.js";
import { SUBAGENT_LAUNCHER_MESSAGES_NOTE, buildSubagentCommonNotes } from "./system-prompt.js";
import { SYSTEM_STATUS_PROTOCOL_NOTE } from "../context/dynamic-sections.js";

export interface SubagentContextBuilderConfig {
  agentPrompt: string;
  currentDate?: string;
  envInfo: EnvInfo;
  model?: Model;
  skillMetadataBudget?: number;
  skills?: ContextBuilderConfig["skills"];
  userInstructions?: ContextBuilderConfig["userInstructions"];
  // workerNotes 与 triggerSessionReadme 过渡补丁已退役（2026-11-20 worker 会话同构化，
  // docs/worker-session-model.md §6）：worker 注入面迁至主 ContextBuilder（workerInstructions），
  // 触发器会话（master 与 worker）都走主 builder 的 Trigger session section；
  // 本 builder 回归上游纯一次性 subagent 语义。
}

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };

export class SubagentContextBuilder extends ContextBuilder {
  private subagentConfig: SubagentContextBuilderConfig;

  constructor(config: SubagentContextBuilderConfig) {
    super(toBaseContextBuilderConfig(config));
    this.subagentConfig = config;
  }

  override setEnvInfo(envInfo: EnvInfo): this {
    this.subagentConfig = {
      ...this.subagentConfig,
      envInfo,
    };
    return this;
  }

  override build(): ContextBuildResult {
    const sections = buildSubagentContextSections(this.subagentConfig);
    const orderedSections = orderSubagentSections(sections);
    const totalChars = orderedSections.reduce((sum, section) => sum + section.chars, 0);
    const totalTokens = orderedSections.reduce((sum, section) => sum + section.tokens, 0);
    const systemSections = orderedSections.filter(
      (section) => section.injectionTarget === "system",
    );
    // 逐段标记会耗尽缓存断点额度，导致对话末尾标记被丢弃；正文合并时保留各段自带的换行。
    const systemMessages = [
      systemSections.filter((section) => section.source === "cli_prefix"),
      systemSections.filter((section) => section.source !== "cli_prefix"),
    ]
      .filter((group) => group.length > 0)
      .map(
        (group): ModelInputMessage => ({
          role: "system",
          content: group.map((section) => section.content).join(""),
          cacheControl: EPHEMERAL_CACHE_CONTROL,
        }),
      );

    return {
      sections: orderedSections,
      totalChars,
      totalTokens,
      systemMessages,
      metaUserAttachments: buildMetaUserAttachments(orderedSections),
    };
  }
}

export function createSubagentContextBuilder(
  config: SubagentContextBuilderConfig,
): SubagentContextBuilder {
  return new SubagentContextBuilder(config);
}

function buildSubagentContextSections(config: SubagentContextBuilderConfig): ContextSection[] {
  const sections: ContextSection[] = [buildCliPrefixSection()];
  // agent 正文首尾都 trim；左边界换行仍由下方按 RobinRun 设计补上。
  const agentPrompt = config.agentPrompt.trim();
  if (agentPrompt) {
    sections.push(
      createSubagentSection({
        name: "Subagent Agent Prompt",
        source: "subagent_agent_prompt",
        cacheHint: "stable",
        // 空 prompt 不是语义段，不能让左边界单独成为 system block。
        // RobinRun by design：Subagent agent prompt 自带相对 CLI prefix 的单换行左边界。
        content: `\n${agentPrompt}`,
      }),
    );
  }

  sections.push(
    createSubagentSection({
      name: "Subagent Notes",
      source: "subagent_notes",
      cacheHint: "stable",
      // RobinRun by design：后续 Subagent system block 统一自带双换行左边界。
      // 启动方消息段排在 Notes 之前；P2.6 消息来源区块协议说明跟在其后（子 agent 同样
      // 每条输入带 <system-status> 区块，需要读懂 sender）。
      content: `\n\n${SUBAGENT_LAUNCHER_MESSAGES_NOTE}\n\n${SYSTEM_STATUS_PROTOCOL_NOTE}\n\n${buildSubagentCommonNotes()}`,
    }),
    ...buildEnvironmentSections(config.envInfo, config.model),
  );

  // 2026-11-19 /init 裁决（docs/init-flow.md §4）：个体规则（上方 agent prompt：身份段 +
  // subagent 自己的规则）在前、项目说明（AGENTS.md）在后，相邻拼进同一
  // system 消息区——每轮由 config 重建，压缩后仍在；meta_user 块只剩 user scope。
  const projectInstructionsSection = buildProjectInstructionsSection({
    userInstructions: config.userInstructions,
  });
  if (projectInstructionsSection) {
    sections.push(projectInstructionsSection);
  }

  const requestUserContextSection = buildRequestUserContextSection({
    userInstructions: config.userInstructions,
  });
  if (requestUserContextSection) {
    sections.push(requestUserContextSection);
  }
  const currentDateSection = buildCurrentDateSection(config.currentDate);
  if (currentDateSection) {
    sections.push(currentDateSection);
  }
  if (config.skills) {
    const skillsSection = buildSkillsSection({
      outcome: config.skills,
      metadataBudget: config.skillMetadataBudget,
    });
    if (skillsSection) {
      sections.push(skillsSection);
    }
  }

  return sections;
}

function orderSubagentSections(sections: ContextSection[]): ContextSection[] {
  return [
    ...sections.filter((section) => section.injectionTarget === "system"),
    ...sections.filter((section) => section.injectionTarget === "meta_user"),
  ];
}

function createSubagentSection(input: {
  name: string;
  source: ContextSection["source"];
  cacheHint: ContextSection["cacheHint"];
  content: string;
}): ContextSection {
  return {
    ...input,
    injectionTarget: "system",
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    preview: input.content.slice(0, 100),
  };
}

function toBaseContextBuilderConfig(config: SubagentContextBuilderConfig): ContextBuilderConfig {
  return {
    workingDirectory: config.envInfo.cwd,
    envInfo: config.envInfo,
    model: config.model,
    currentDate: config.currentDate,
    skillMetadataBudget: config.skillMetadataBudget,
    skills: config.skills,
  };
}
