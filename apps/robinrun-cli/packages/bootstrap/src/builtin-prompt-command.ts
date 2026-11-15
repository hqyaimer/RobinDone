import { join } from "node:path";
import {
  BUILTIN_WORKFLOW_COMMAND_NAME,
  expandBuiltinWorkflowCommandPrompt,
} from "./builtin-workflow-command.js";

const BUILTIN_PROMPT_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;
const INIT_COMMAND_NAME = "init";

export interface ResolveRobinRunBuiltinPromptCommandOptions {
  /**
   * 动态工作流灰度门（docs/dynamic-workflow/launch.md「Gray release」）。**只有显式 false 才挡下**
   * `/workflow`：TUI / headless 从不设置该字段，那里的功能始终开启。挡下时返回 undefined，
   * 与「命令不存在」同形——`workflow` 是保留名，后续的自定义命令解析同样拒绝展开，于是原文作为
   * 普通 prompt 交给模型，与目录侧剔除它的结论一致（DWG-03）。
   */
  dynamicWorkflowEnabled?: boolean;
  workingDirectory?: string;
}

export interface ResolvedRobinRunBuiltinPromptCommand {
  /** 命中的内置命令名（`init` / `workflow`），调用方据此挂命令特有的副作用（如 onDemand 激活）。 */
  name: string;
  prompt: string;
}

export function resolveRobinRunBuiltinPromptCommand(
  input: string,
  options: ResolveRobinRunBuiltinPromptCommandOptions = {},
): string | undefined {
  return resolveRobinRunBuiltinPromptCommandInvocation(input, options)?.prompt;
}

export function resolveRobinRunBuiltinPromptCommandInvocation(
  input: string,
  options: ResolveRobinRunBuiltinPromptCommandOptions = {},
): ResolvedRobinRunBuiltinPromptCommand | undefined {
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
    ? [
        "",
        "Additional user instructions supplied with /init:",
        "```text",
        params.args,
        "```",
      ].join("\n")
    : "";

  return [
    "You are running RobinRun's built-in /init command.",
    "",
    "Your task is to create or update a concise workspace instruction file for future RobinRun agents, then scaffold the workspace's resident agent definitions.",
    "",
    "Target:",
    `- Workspace directory: ${params.workingDirectory}`,
    `- Instruction file: ${params.targetPath}`,
    `- Existing hidden instruction candidates: ${join(params.workingDirectory, ".robinrun", "AGENTS.md")} and ${join(params.workingDirectory, ".agents", "AGENTS.md")}`,
    `- Resident agent definitions directory: ${join(params.workingDirectory, ".robinrun", "agents")}`,
    "- File name must be exactly AGENTS.md.",
    "- This command targets the current workspace only. Do not write ~/.robinrun/AGENTS.md.",
    additionalInstructions,
    "",
    "Process:",
    "1. First check whether .robinrun/AGENTS.md or .agents/AGENTS.md exists in the workspace. If either exists, tell the user they already have an instructions file, mention the path found, and stop without creating a new AGENTS.md.",
    "2. Inspect the repository before writing. Prefer Read, Glob, Grep, and safe Bash commands such as ls, find, git status, and package-manager script inspection.",
    "3. If AGENTS.md already exists, read it first and update it with Edit instead of replacing it wholesale.",
    "4. If AGENTS.md does not exist, create it at the workspace root.",
    "5. Keep the file practical and short enough for future agents to read quickly.",
    "6. Include only project-specific facts future RobinRun agents would otherwise miss.",
    "7. Ask the user only if a repository-specific decision cannot be inferred and would materially change the file.",
    "8. After AGENTS.md is ready, decide the resident agent set from the workspace's actual division of labor. For a RobinRun operations project this means at least a development agent and an operations agent; merge roles when the project is small, and skip this step entirely for plain code or scratch workspaces where resident agents add no value.",
    "9. Create each resident agent definition as .robinrun/agents/<name>.md: YAML frontmatter with name, description, and tools, followed by the agent's prompt. If a definition already exists, read it first and refine it with Edit instead of replacing it wholesale.",
    "10. Ask the user before creating an agent whose role you cannot infer confidently.",
    "",
    "Recommended AGENTS.md content:",
    "- Repository purpose and major directories.",
    "- Build, typecheck, lint, and focused test commands discovered from the repo.",
    "- Architecture boundaries and layer rules that matter for edits.",
    "- Coding conventions, import/path rules, logging rules, UI/design rules, and platform compatibility constraints if present.",
    "- Known gotchas for desktop app, web, remote, stdio, protocols, or agent runtime if this repo has them.",
    "- Any documentation files that agents should read before changing sensitive areas.",
    "",
    "Recommended resident agent definition content:",
    "- Frontmatter: name (lowercase, hyphenated), description (when to reach for this agent), tools it may use.",
    "- Prompt: the agent's responsibility, its working style, and what it reports back.",
    "- Keep one responsibility per agent; state explicitly that resident agents report to the main agent.",
    "",
    "After creating or editing AGENTS.md and the agent definitions, summarize the main sections you wrote, list the agents you created with their responsibilities, and mention the file paths.",
  ].join("\n");
}
