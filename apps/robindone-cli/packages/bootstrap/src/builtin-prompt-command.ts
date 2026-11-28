import { join } from "node:path";
import {
  BUILTIN_WORKFLOW_COMMAND_NAME,
  expandBuiltinWorkflowCommandPrompt,
} from "./builtin-workflow-command.js";

const BUILTIN_PROMPT_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;
const INIT_COMMAND_NAME = "init";

export interface ResolveRobinDoneBuiltinPromptCommandOptions {
  /**
   * 动态工作流灰度门（docs/dynamic-workflow/launch.md「Gray release」）。**只有显式 false 才挡下**
   * `/workflow`：TUI / headless 从不设置该字段，那里的功能始终开启。挡下时返回 undefined，
   * 与「命令不存在」同形——`workflow` 是保留名，后续的自定义命令解析同样拒绝展开，于是原文作为
   * 普通 prompt 交给模型，与目录侧剔除它的结论一致（DWG-03）。
   */
  dynamicWorkflowEnabled?: boolean;
  workingDirectory?: string;
}

export interface ResolvedRobinDoneBuiltinPromptCommand {
  /** 命中的内置命令名（`init` / `workflow`），调用方据此挂命令特有的副作用（如 onDemand 激活）。 */
  name: string;
  prompt: string;
}

export function resolveRobinDoneBuiltinPromptCommand(
  input: string,
  options: ResolveRobinDoneBuiltinPromptCommandOptions = {},
): string | undefined {
  return resolveRobinDoneBuiltinPromptCommandInvocation(input, options)?.prompt;
}

export function resolveRobinDoneBuiltinPromptCommandInvocation(
  input: string,
  options: ResolveRobinDoneBuiltinPromptCommandOptions = {},
): ResolvedRobinDoneBuiltinPromptCommand | undefined {
  const invocation = parseBuiltinPromptCommandInvocation(input);
  if (!invocation) {
    return undefined;
  }

  if (invocation.name === INIT_COMMAND_NAME) {
    const workingDirectory = options.workingDirectory ?? process.cwd();
    return {
      name: INIT_COMMAND_NAME,
      prompt: buildInitAgentsPrompt({
        args: invocation.args,
        targetPath: join(workingDirectory, "AGENTS.md"),
        workingDirectory,
      }),
    };
  }

  if (invocation.name === BUILTIN_WORKFLOW_COMMAND_NAME) {
    if (options.dynamicWorkflowEnabled === false) {
      return undefined;
    }
    return {
      name: BUILTIN_WORKFLOW_COMMAND_NAME,
      prompt: expandBuiltinWorkflowCommandPrompt(invocation.args),
    };
  }

  return undefined;
}

function parseBuiltinPromptCommandInvocation(input: string): { args: string; name: string } | null {
  const match = BUILTIN_PROMPT_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}

function buildInitAgentsPrompt(params: {
  args: string;
  targetPath: string;
  workingDirectory: string;
}): string {
  const additionalInstructions = params.args
    ? ["", "Additional user instructions supplied with /init:", "```text", params.args, "```"].join(
        "\n",
      )
    : "";
  const masterAgentsMdPath = join(
    params.workingDirectory,
    ".robindone",
    "agents",
    "master",
    "agents.md",
  );

  return [
    "You are running RobinDone's built-in /init command.",
    "",
    "Your task is to initialize the project's agent workspace in three steps: (1) the project instruction file AGENTS.md — a project briefing, not a constitution; (2) the worker roster, if recurring duties justify workers; (3) your own agent rules file (agents.md) as the master agent (主智能体) — the project's general manager (项目总管).",
    "",
    "Targets:",
    `- Workspace directory: ${params.workingDirectory}`,
    `- Project briefing file: ${params.targetPath}`,
    `- Master agent rules file: ${masterAgentsMdPath}`,
    `- Worker roster registry: ${join(params.workingDirectory, ".robindone", "agents", "workers.json")} (program-managed; change it only through the ManageWorkers tool)`,
    "- This command targets the current workspace only. Do not write ~/.robindone/AGENTS.md.",
    additionalInstructions,
    "",
    "Re-run semantics (per-step guards, no global abort): each step checks only its own target. A file that already exists is kept and never rewritten wholesale; missing pieces are filled in. Never abort the whole run because one target already exists.",
    "",
    "Step 1 — Project briefing (AGENTS.md):",
    "- If AGENTS.md already exists at the workspace root, keep it (use Edit only if an update is clearly needed) and continue with Step 2.",
    "- Otherwise inspect the repository first (Read, Glob, Grep, and safe Bash commands such as ls, find, git status, and package-manager script inspection), then create it at the workspace root.",
    "- File name must be exactly AGENTS.md.",
    "- Audience: every agent in this project (master, workers, one-off subagents) receives this file in its system prompt to quickly understand the project background. Keep it practical and short.",
    "- Content: project background and positioning; goals and current phase; overall structure (repo layout and architecture boundaries for code projects, business structure for non-code projects); collaboration notes (the roster is managed by the master agent, worker-to-worker communication goes through the master agent, outbound actions go through the review flow); glossary; recommended conventions; known gotchas.",
    "- Content discipline: this file is a briefing — project description, recommended conventions, and notes only. Anything only the master agent needs goes into your own agents.md (Step 3); anything only one worker needs goes into that worker's files (its define.md for duty statements, its agents.md or knowledge/ for the rest). Content that does not help an agent quickly understand the project must NOT go into this file.",
    "",
    "Step 2 — Worker roster:",
    "- Decide from the workspace's actual division of labor whether recurring duties justify workers. The master agent is the only required member; development and operations workers are common examples, not a required minimum. Merge roles when the project is small, and skip this step entirely for workspaces (including plain code or scratch ones) where workers add no value.",
    "- Create workers directly without asking the user for confirmation first.",
    "- Create each worker only through the ManageWorkers tool (never by writing files under .robindone/agents directly): pass name, description, and the prompt that becomes the worker's duty definition (define.md). The name is only the sidebar display label — pick a human-readable role name (natural words, Chinese welcome, e.g. 开发工程师), not a code-style slug; duplicates are allowed but discouraged, because addressing always uses the immutable wkr-id the tool returns (via ContactAgent, never the Agent tool). Keep the roster minimal — a worker is for a duty that will recur, not for a one-off task.",
    "- The prompt passed to ManageWorkers create IS the worker's duty definition (define.md). Write it as a duty statement:",
    "  - Who the worker is: a one-line duty; a roster member reporting to the master agent (主智能体).",
    "  - What it IS responsible for: the duty plus typical tasks.",
    "  - What it is NOT responsible for: neighboring duties it must leave alone (describe duties; never name other workers).",
    "  - Boundary handling: anything outside its duties → contact the master agent (ContactAgent); never expand on its own.",
    "  - Collaboration discipline: report to the master agent; outbound content always goes through the review flow.",
    "  - The tool scaffolds the rest: the worker's own agents.md starts as a skeleton the worker maintains itself (its findings, conventions, and knowledge index — never duty definitions), plus plan/ (one file per plan, progress updated in real time), knowledge/ (accumulated experience, freely organized), and tmp/ (disposable working files).",
    "- Re-run guard: workers that already exist are kept — never recreate them and never rewrite their define.md. Only fill gaps: if a worker's define.md exists but lacks the NOT-responsible/boundary sections, Edit to append them; if a worker's agents.md is missing, recreate only the skeleton (write the file directly: a title, one line stating it is the worker's own notes and that duty definitions live in define.md, and an empty '## Index' section).",
    "",
    "Step 3 — Master agents.md:",
    `- Create ${masterAgentsMdPath} (create the sibling plan/, knowledge/, tmp/ directories too). If it already exists, keep it.`,
    // F5（2026-11-23 用户裁决）：邮件系统未落地，媒体人工审核与重大决策的提报统一收敛为
    // "写待办（文件）"——不写 email、不写应用内通知（渠道落地前模型不应引用不存在的通道）。
    "- Write your own management rules: your identity — the project's general manager (项目总管), overall owner responsible for everything in the project; you may act in functions the roster leaves uncovered yourself, but your standing title is always 项目总管, never a single functional role; roster management rules (a worker is for a duty that will recur; when the roster or a worker's duties change, update the affected worker's define.md); dispatch strategy (worker vs one-off subagent, foreground vs background); review loop orchestration (outbound actions reviewed before publishing, media content goes to the user for manual review — record a todo item for them, keep the action ledger); pacing control (reply frequency, daily caps); major-decision threshold (write a todo item for the user before executing); file maintenance (keep AGENTS.md a briefing — anti-bloat self-check at session wrap-up); a knowledge/ index (user preferences, major decision log).",
    "",
    "After finishing, summarize: the sections you wrote in AGENTS.md, the workers you created with their duties and wkr-ids, the master agents.md path, and how the files are injected (every agent gets the project AGENTS.md in its system prompt; each worker additionally gets its define.md and its own agents.md, in that order).",
  ].join("\n");
}
