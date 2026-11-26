// AskUserQuestion 答案读取回归（2026-11-26 实测缺陷）：工具终态 output 的展示文本是
// 模型可见的 `"q"="a"` 格式串；问题/答案含 ASCII 双引号时朴素配对正则被截断——配对键
// 错位后按问题原文查不到答案，展开显示"未提供回答"（模型侧收到完整文本不受影响，
// 只有显示层丢失）。锚点解析以 input 的确切问题文本定位，对任意引号内容稳健；
// runtime 自动继续（超时未答）的前缀文案映射为空对象，渲染层显示"已自动继续"。
import { describe, expect, it } from "vitest";

import { readAskUserQuestionAnswers } from "../src/lib/askUserQuestion.js";

const QUOTED_QUESTION =
  'APP-0001 的 acknowledge 是你在面板 UI 上操作的吗（那句"已按用户批准意见执行完毕..."的备注也是你写的）？';

function harness(overrides: {
  question?: string;
  outputText?: string;
}) {
  const question = overrides.question ?? QUOTED_QUESTION;
  return {
    input: { questions: [{ question, options: ["是", "否"] }] },
    output: overrides.outputText === undefined ? undefined : { text: overrides.outputText },
  };
}

describe("readAskUserQuestionAnswers", () => {
  it("问题文本含 ASCII 引号时按锚点解析出完整答案（实测缺陷回归）", () => {
    const value = harness({
      outputText: `User has answered your questions: "${QUOTED_QUESTION}"="不是，ack 是那个触发器会话代写的，我只在面板上批准了。".`,
    });
    const answers = readAskUserQuestionAnswers(value);
    expect(answers?.[QUOTED_QUESTION]).toBe(
      "不是，ack 是那个触发器会话代写的，我只在面板上批准了。",
    );
  });

  it("答案自身含引号时不截断（末题取收尾句点前的最后一个引号）", () => {
    const value = harness({
      outputText: `User has answered your questions: "${QUOTED_QUESTION}"="我说了"不是"然后继续。".`,
    });
    expect(readAskUserQuestionAnswers(value)?.[QUOTED_QUESTION]).toBe(
      '我说了"不是"然后继续。',
    );
  });

  it("常规无引号问题仍正确解析；多题按分隔拆分", () => {
    const plain = harness({
      question: "用哪个方案？",
      outputText: 'User has answered your questions: "用哪个方案？"="方案 A".',
    });
    expect(readAskUserQuestionAnswers(plain)?.["用哪个方案？"]).toBe("方案 A");

    const multi = harness({
      question: "第一题？",
      outputText: 'User has answered your questions: "第一题？"="甲", "第二题？"="乙".',
    });
    const answers = readAskUserQuestionAnswers({
      input: {
        questions: [{ question: "第一题？", options: [] }, { question: "第二题？", options: [] }],
      },
      output: multi.output,
    });
    expect(answers?.["第一题？"]).toBe("甲");
    expect(answers?.["第二题？"]).toBe("乙");
  });

  it("runtime 自动继续的前缀文案映射为空对象（渲染层显示已自动继续）", () => {
    const value = harness({
      outputText:
        "The user did not provide answers to these questions. Continue using your best judgment; do not treat this as a rejection or invent a user preference.",
    });
    const answers = readAskUserQuestionAnswers(value);
    expect(answers).toEqual({});
  });

  it("确无配对时返回 undefined（渲染层显示未提供回答）", () => {
    const value = harness({ outputText: "The tool was cancelled." });
    expect(readAskUserQuestionAnswers(value)).toBeUndefined();
  });
});
