import { describe, expect, it } from "vitest";
import { composeWorkerAgentPrompt } from "../src/subagent/worker-prompt.js";
import type { WorkerProfileIdentity } from "@robinrun/shared";

const WORKER: WorkerProfileIdentity = {
  workerId: "wkr-ab12cd34",
  workerName: "开发工程师",
  defineMd: "DUTY-DEFINITION-SENTINEL",
};
const AGENTS_MD = "SELF-MAINTAINED-SENTINEL";

describe("composeWorkerAgentPrompt (裁决 10 四段拼接的前三段)", () => {
  it("拼接顺序固定：define.md → agents.md → 预定义提示词", () => {
    const prompt = composeWorkerAgentPrompt({ worker: WORKER, agentsMd: AGENTS_MD });

    const defineIndex = prompt.indexOf("DUTY-DEFINITION-SENTINEL");
    const agentsIndex = prompt.indexOf("SELF-MAINTAINED-SENTINEL");
    const predefinedIndex = prompt.indexOf("# Identity: worker agent (工作者)");
    expect(defineIndex).toBeGreaterThanOrEqual(0);
    expect(agentsIndex).toBeGreaterThan(defineIndex);
    expect(predefinedIndex).toBeGreaterThan(agentsIndex);
    // 项目 AGENTS.md（第④段）不在这里——由 SubagentContextBuilder 的 project instructions
    // section 承载，本模块不得越权拼接。
    expect(prompt).not.toContain("project instructions");
  });

  it("define.md 段带来源标注与不可改约束（纯提示词约束，无「觉得有误就提请」例外条款）", () => {
    const prompt = composeWorkerAgentPrompt({ worker: WORKER, agentsMd: AGENTS_MD });

    expect(prompt).toContain("## Your duty definition — `.robinrun/agents/wkr-ab12cd34/define.md`");
    expect(prompt).toContain("maintained exclusively by the master agent");
    expect(prompt).toContain("Do not modify it — not with Write/Edit, not through shell commands");
    // 不可改约束不允许 softened escape clause。
    expect(prompt).not.toMatch(/if you (?:think|believe)[^]*contact the master[^]*define\.md/iu);
  });

  it("agents.md 段只加来源标注与用途边界，正文原样保留", () => {
    const prompt = composeWorkerAgentPrompt({ worker: WORKER, agentsMd: AGENTS_MD });

    expect(prompt).toContain(
      "## Your self-maintained notes — `.robinrun/agents/wkr-ab12cd34/agents.md`",
    );
    expect(prompt).toContain("it does NOT define your duties");
    expect(prompt).toContain("SELF-MAINTAINED-SENTINEL");
  });

  it("预定义提示词含身份、状态管理指南与跨会话文件记忆纪律", () => {
    const prompt = composeWorkerAgentPrompt({ worker: WORKER, agentsMd: AGENTS_MD });

    expect(prompt).toContain('You are "开发工程师" (immutable id: wkr-ab12cd34)');
    expect(prompt).toContain("## Your state lives in files, not in sessions");
    // plan 一计划一文件实时更新；knowledge 分而治之 + 索引同步 + 追加不重写；tmp 临时。
    expect(prompt).toContain("`.robinrun/agents/wkr-ab12cd34/plan/` — one file per plan");
    expect(prompt).toContain("`.robinrun/agents/wkr-ab12cd34/knowledge/`");
    expect(prompt).toContain("Keep the index in sync whenever the file tree changes");
    expect(prompt).toContain("Record experience entries by appending");
    expect(prompt).toContain("`.robinrun/agents/wkr-ab12cd34/tmp/`");
    // 文件是跨会话唯一可信状态，会话只承载过程。
    expect(prompt).toContain("the only trusted state that carries across sessions");
  });

  it("协作契约保留 master 管理、<system-status> 来源、ContactAgent 回话语义与持久身份", () => {
    const prompt = composeWorkerAgentPrompt({ worker: WORKER, agentsMd: AGENTS_MD });

    expect(prompt).toContain("## Collaboration contract");
    // 同构化（2026-11-20）：master 是唯一对话方，任务经 ContactAgent 请求-响应往返。
    expect(prompt).toContain("A master agent (主智能体) manages you and is your only counterpart");
    expect(prompt).toContain("Communication between you and other workers is always relayed by the master");
    expect(prompt).toContain("via its <system-status> block");
    expect(prompt).toContain("your turn-final output is returned to it as the reply");
    expect(prompt).toContain("You are NOT a disposable subagent");
    // 职责外事项 → ContactAgent 主智能体，不自行扩展。
    expect(prompt).toContain("contact the master agent via ContactAgent");
    // 积压通知/脱钩交接的 P2.5 语义已退役，不得回潮。
    expect(prompt).not.toContain("backlog notification");
  });

  it("defineMd 缺失时保留段头说明不掷错（加载器保证文件存在，此处只防御空正文）", () => {
    const prompt = composeWorkerAgentPrompt({
      worker: { workerId: "wkr-00000001", workerName: "dev" },
      agentsMd: AGENTS_MD,
    });

    expect(prompt).toContain("## Your duty definition — `.robinrun/agents/wkr-00000001/define.md`");
    expect(prompt).toContain("SELF-MAINTAINED-SENTINEL");
  });
});
