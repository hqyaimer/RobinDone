type RobinDoneUserQuestionAnswers = Record<string, unknown>;

type AskUserQuestionType = "single" | "multiple";

interface AskUserQuestionOption {
  id: string;
  label: string;
  description?: string;
  placeholder?: string;
  requiresInput: boolean;
}

interface AskUserQuestionItem {
  id: string;
  question: string;
  type: AskUserQuestionType;
  options: AskUserQuestionOption[];
  customInput?: AskUserQuestionOption;
}

interface AskUserQuestionData {
  questions: AskUserQuestionItem[];
  answers?: RobinDoneUserQuestionAnswers;
}

interface AskUserQuestionAnswerDraft {
  selectedOptionIds: string[];
  customInput: string;
}

const CUSTOM_INPUT_FLAGS = [
  "requiresInput",
  "customInput",
  "isCustom",
  "freeText",
  "allowFreeText",
] as const;
const CUSTOM_INPUT_LABEL_PATTERN =
  /(其他|其它|自定义|自行|自己|补充|填写|填入|输入|other|custom|free\s*text|specify|write\s*in)/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function readBoolean(record: Record<string, unknown>, keys: readonly string[]) {
  return keys.some((key) => record[key] === true);
}

function normalizeOption(value: unknown, index: number): AskUserQuestionOption | null {
  if (typeof value === "string") {
    return {
      id: `option-${index}`,
      label: value,
      requiresInput: false,
    };
  }

  if (!isPlainRecord(value)) {
    return null;
  }

  const label =
    readString(value, ["label", "name", "title", "text", "value"]) ?? JSON.stringify(value);
  const id = readString(value, ["id", "optionId", "value", "key"]) ?? label;
  const placeholder = readString(value, [
    "placeholder",
    "customInputPlaceholder",
    "freeTextPlaceholder",
    "inputPlaceholder",
  ]);

  return {
    id,
    label,
    description: readString(value, ["description", "detail", "help", "hint"]),
    placeholder,
    requiresInput:
      readBoolean(value, CUSTOM_INPUT_FLAGS) || (index >= 0 && placeholder !== undefined),
  };
}

function isImplicitCustomInputOption(option: AskUserQuestionOption | undefined) {
  if (!option) {
    return false;
  }
  return CUSTOM_INPUT_LABEL_PATTERN.test(option.label);
}

function readQuestions(input: unknown): unknown[] {
  if (!isPlainRecord(input)) {
    return [];
  }
  const questions = input.questions;
  if (Array.isArray(questions)) {
    return questions;
  }
  // Bugfix: RobinDone Agent 的 AskUserQuestion 工具输入是单题结构：
  // { header, question, options }，不是多题结构 { questions: [...] }。
  // 这里把单题结构归一化成同一条 questions 管线，避免消息流工具块显示“没有可回答的问题”。
  return typeof input.question === "string" && Array.isArray(input.options) ? [input] : [];
}

function readAnswers(input: unknown): RobinDoneUserQuestionAnswers | undefined {
  if (!isPlainRecord(input)) {
    return undefined;
  }
  const answers = input.answers;
  return isPlainRecord(answers) ? answers : undefined;
}

function parseClaudeAskUserQuestionOutput(
  output: unknown,
): RobinDoneUserQuestionAnswers | undefined {
  if (typeof output !== "string" || output.trim().length === 0) {
    return undefined;
  }

  const answers: RobinDoneUserQuestionAnswers = {};
  const answerPattern = /"([^"]+)"="([^"]*)"/g;
  for (const match of output.matchAll(answerPattern)) {
    const question = match[1]?.trim();
    if (!question) {
      continue;
    }
    answers[question] = match[2] ?? "";
  }

  return Object.keys(answers).length > 0 ? answers : undefined;
}

/** 工具终态 output 的展示文本（toolCall.output = { text } 或裸字符串；见 toolDisplay.ts）。 */
function readOutputDisplayText(candidate: unknown): string | undefined {
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate;
  }
  if (
    isPlainRecord(candidate) &&
    typeof candidate.text === "string" &&
    candidate.text.trim().length > 0
  ) {
    return candidate.text;
  }
  return undefined;
}

/** runtime 自动继续（超时未答）的模型文案前缀：空 answers 的显式成功语义。 */
const AUTO_CONTINUED_OUTPUT_PREFIX = "The user did not provide answers";

/**
 * 以 input 的确切问题文本为锚点，从模型可见的应答文本（formatAskUserQuestionModelContent
 * 产物：`User has answered your questions: "q"="a", ...`）解析答案。
 * 2026-11-26 实测缺陷（用户手写回答展开显示"未提供回答"）：问题文本含 ASCII 双引号时，
 * 朴素配对正则 `"([^"]+)"="([^"]*)"` 被内嵌引号截断——配对键错位后按问题原文查不到答案。
 * 模型侧收到的是完整文本不受影响，只有显示层丢失。锚点方案对任意引号内容稳健：
 * 非末题答案终止于下一题分隔 `", "`；末题终止于收尾句点前的最后一个引号（答案自身可含引号）。
 */
function parseAnchoredAnswers(
  outputText: string,
  questionTexts: string[],
): RobinDoneUserQuestionAnswers | undefined {
  const answers: RobinDoneUserQuestionAnswers = {};
  questionTexts.forEach((questionText, index) => {
    const anchor = `"${questionText}"="`;
    const start = outputText.indexOf(anchor);
    if (start < 0) {
      return;
    }
    const rest = outputText.slice(start + anchor.length);
    const isLastQuestion = index === questionTexts.length - 1;
    let answer: string;
    if (isLastQuestion) {
      const closingQuote = rest.lastIndexOf('"');
      answer = closingQuote < 0 ? rest : rest.slice(0, closingQuote);
    } else {
      const separator = rest.indexOf('", "');
      answer = separator < 0 ? rest : rest.slice(0, separator);
    }
    answers[questionText] = answer;
  });
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function parseJsonRecord(output: unknown): Record<string, unknown> | undefined {
  if (isPlainRecord(output)) {
    return output;
  }
  if (typeof output !== "string" || output.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(output) as unknown;
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readNestedAskUserQuestionAnswers(
  input: unknown,
): RobinDoneUserQuestionAnswers | undefined {
  const directTextAnswers = parseClaudeAskUserQuestionOutput(input);
  if (directTextAnswers) {
    return directTextAnswers;
  }

  const record = parseJsonRecord(input);
  if (!record) {
    return undefined;
  }

  const directAnswers = readAnswers(record);
  if (directAnswers) {
    return directAnswers;
  }

  const contentAnswers = readNestedAskUserQuestionAnswers(record.content);
  if (contentAnswers) {
    return contentAnswers;
  }

  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      const itemAnswers = readNestedAskUserQuestionAnswers(item);
      if (itemAnswers) {
        return itemAnswers;
      }
    }
  }

  const textAnswers = parseClaudeAskUserQuestionOutput(record.text);
  if (textAnswers) {
    return textAnswers;
  }

  const rawOutputAnswers = readNestedAskUserQuestionAnswers(record.rawOutput);
  if (rawOutputAnswers) {
    return rawOutputAnswers;
  }

  return readNestedAskUserQuestionAnswers(record.output);
}

function parseRobinDoneAskUserQuestionOutput(
  output: unknown,
  input: unknown,
): RobinDoneUserQuestionAnswers | undefined {
  const outputRecord = parseJsonRecord(output);
  if (!outputRecord) {
    return undefined;
  }

  const data = normalizeAskUserQuestionInput(input);
  const question = data.questions[0];
  if (!question) {
    return undefined;
  }

  const type = outputRecord.type;
  const rawAnswer =
    type === "answered"
      ? outputRecord.selected
      : type === "answered_custom"
        ? outputRecord.text
        : undefined;
  if (typeof rawAnswer !== "string") {
    return undefined;
  }

  return {
    [question.question]: rawAnswer,
  };
}

function normalizeQuestion(value: unknown, index: number): AskUserQuestionItem | null {
  if (!isPlainRecord(value)) {
    return null;
  }

  const question = readString(value, ["question", "prompt", "label", "title", "text"]);
  if (!question) {
    return null;
  }

  const rawOptions = Array.isArray(value.options) ? value.options : [];
  const options = rawOptions
    .map((option, optionIndex) => normalizeOption(option, optionIndex))
    .filter((option): option is AskUserQuestionOption => option !== null);
  const questionPlaceholder = readString(value, [
    "customInputPlaceholder",
    "freeTextPlaceholder",
    "inputPlaceholder",
  ]);
  const lastOption = options.at(-1);
  const lastOptionIsCustomInput =
    lastOption !== undefined &&
    (lastOption.requiresInput === true || isImplicitCustomInputOption(lastOption));
  const customInput =
    lastOptionIsCustomInput && lastOption
      ? {
          ...lastOption,
          placeholder: lastOption.placeholder ?? lastOption.label,
          requiresInput: true,
        }
      : questionPlaceholder
        ? {
            id: `custom-${index}`,
            label: questionPlaceholder,
            placeholder: questionPlaceholder,
            requiresInput: true,
          }
        : undefined;
  const normalizedOptions = lastOptionIsCustomInput ? options.slice(0, -1) : options;
  const type =
    value.multiple === true ||
    value.multiSelect === true ||
    value.type === "multiple" ||
    value.type === "multi"
      ? "multiple"
      : "single";

  return {
    id: readString(value, ["id", "key", "name"]) ?? `question-${index}`,
    question,
    type,
    options: normalizedOptions,
    customInput,
  };
}

export function normalizeAskUserQuestionInput(input: unknown): AskUserQuestionData {
  return {
    questions: readQuestions(input)
      .map((question, index) => normalizeQuestion(question, index))
      .filter((question): question is AskUserQuestionItem => question !== null),
    answers: readAnswers(input),
  };
}

export function readAskUserQuestionInput(value: {
  input?: unknown;
  output?: unknown;
  raw?: unknown;
}): unknown {
  if (readQuestions(value.input).length > 0) {
    return value.input;
  }
  if (isPlainRecord(value.raw)) {
    if (readQuestions(value.raw.rawInput).length > 0) {
      return value.raw.rawInput;
    }
    if (readQuestions(value.raw.input).length > 0) {
      return value.raw.input;
    }
  }
  return value.input;
}

export function readAskUserQuestionAnswers(value: {
  input?: unknown;
  output?: unknown;
  raw?: unknown;
}): RobinDoneUserQuestionAnswers | undefined {
  // 锚点解析优先于朴素配对（2026-11-26 实测缺陷修复）：朴素正则在问题/答案含 ASCII
  // 引号时会配对错位且仍返回非空结果，抢占后续读取路径——必须先按确切问题文本锚定。
  const raw = isPlainRecord(value.raw) ? value.raw : undefined;
  const displayText =
    readOutputDisplayText(value.output) ??
    readOutputDisplayText(raw?.rawOutput) ??
    readOutputDisplayText(raw?.output);
  if (displayText !== undefined) {
    if (displayText.trimStart().startsWith(AUTO_CONTINUED_OUTPUT_PREFIX)) {
      // runtime 自动继续的显式语义：空对象让渲染层显示"已自动继续"而非"未提供回答"。
      return {};
    }
    const questionTexts = normalizeAskUserQuestionInput(
      readAskUserQuestionInput(value),
    ).questions.map((question) => question.question);
    const anchored = parseAnchoredAnswers(displayText, questionTexts);
    if (anchored !== undefined) {
      return anchored;
    }
  }
  const nestedOutputAnswers = readNestedAskUserQuestionAnswers(value.output);
  if (nestedOutputAnswers) {
    return nestedOutputAnswers;
  }
  // Bugfix: Claude 历史里的 AskUserQuestion output 会落成一段文本
  // `"问题"="答案"`，而不是结构化 answers。历史 snapshot 覆盖实时态后，
  // 只读结果会因为读不到 answers 退回 No answer provided，这里兼容解析该格式。
  const parsedOutputAnswers = parseClaudeAskUserQuestionOutput(value.output);
  if (parsedOutputAnswers) {
    return parsedOutputAnswers;
  }
  const parsedRobinDoneOutputAnswers = parseRobinDoneAskUserQuestionOutput(
    value.output,
    readAskUserQuestionInput(value),
  );
  if (parsedRobinDoneOutputAnswers) {
    return parsedRobinDoneOutputAnswers;
  }
  if (isPlainRecord(value.input) && isPlainRecord(value.input.answers)) {
    return value.input.answers;
  }
  if (isPlainRecord(value.raw)) {
    const nestedRawOutputAnswers = readNestedAskUserQuestionAnswers(value.raw.rawOutput);
    if (nestedRawOutputAnswers) {
      return nestedRawOutputAnswers;
    }
    const parsedRawOutputAnswers = parseClaudeAskUserQuestionOutput(value.raw.rawOutput);
    if (parsedRawOutputAnswers) {
      return parsedRawOutputAnswers;
    }
    const parsedRawRobinDoneOutputAnswers = parseRobinDoneAskUserQuestionOutput(
      value.raw.rawOutput,
      readAskUserQuestionInput(value),
    );
    if (parsedRawRobinDoneOutputAnswers) {
      return parsedRawRobinDoneOutputAnswers;
    }
    const nestedRawAnswers = readNestedAskUserQuestionAnswers(value.raw.output);
    if (nestedRawAnswers) {
      return nestedRawAnswers;
    }
    const parsedRawAnswers = parseClaudeAskUserQuestionOutput(value.raw.output);
    if (parsedRawAnswers) {
      return parsedRawAnswers;
    }
    const parsedRawRobinDoneAnswers = parseRobinDoneAskUserQuestionOutput(
      value.raw.output,
      readAskUserQuestionInput(value),
    );
    if (parsedRawRobinDoneAnswers) {
      return parsedRawRobinDoneAnswers;
    }
    const nestedRawContentAnswers = readNestedAskUserQuestionAnswers(value.raw.content);
    if (nestedRawContentAnswers) {
      return nestedRawContentAnswers;
    }
  }
  return undefined;
}

export function getAskUserQuestionAnswerText(
  question: AskUserQuestionItem,
  answers: RobinDoneUserQuestionAnswers | undefined,
  noAnswerText: string,
) {
  const value = answers?.[question.question] ?? answers?.[question.id];
  if (Array.isArray(value)) {
    const values = value.map((item) => String(item).trim()).filter((item) => item.length > 0);
    return values.length > 0 ? values.join("，") : noAnswerText;
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : noAnswerText;
  }
  if (value === undefined || value === null) {
    return noAnswerText;
  }
  return String(value);
}
