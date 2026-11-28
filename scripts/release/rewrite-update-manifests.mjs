#!/usr/bin/env node
// RobinDone 发布工程：把 electron-builder 生成的 latest*.yml 更新清单改写为静态 feed 形态。
//
// 三个职责：
// 1. 清单里的相对文件名（url/path 字段）改写为指向 GitHub Release 附件的绝对 URL——
//    客户端静态 feed 从 raw.githubusercontent.com 读 yml，但安装包在 Release 附件上，
//    相对路径会错误解析到 raw 的 origin 根（manifestUpdateProvider.resolveBaseUrl 语义）。
// 2. 平台目录落位：客户端静态清单地址固定为 "{base}/{releasePlatform}/latest.yml"
//    （见 manifestUpdateProvider.ts resolveStaticManifestBase / buildElectronManifestUrl），
//    所以无论源文件叫 latest.yml / latest-mac.yml / latest-linux.yml，落位后统一叫 latest.yml。
// 3. 更新说明注入（2026-11-26）：`--release-notes`（中文，必填标题语义的 markdown）与
//    `--release-notes-en`（可选英文）把 docs/release-notes/<tag>.md 内容作为 releaseNotes /
//    releaseNotesByLocale 字段追加进清单，随 update-available/update-downloaded 到达
//    更新弹窗（main 侧 toPostUpdateReleaseNotesPayload 现成管线；文件缺失 = 不注入，
//    弹窗不显示说明区块）。
//
// 文本级逐行替换而非 YAML round-trip：electron-builder 生成的清单是稳定的平铺格式，
// 文本替换可原样保留其余字段与格式，避免解析器重排/引号漂移引入的意外 diff。
// 用法（CI release job 每平台调一次）：
//   node scripts/release/rewrite-update-manifests.mjs \
//     --manifest artifacts/dist-win-x64/latest.yml \
//     --platform windows-x86_64 \
//     --base https://github.com/<owner>/<repo>/releases/download/v0.1.0 \
//     --out-root updates-staging \
//     [--release-notes docs/release-notes/v0.1.0.md] \
//     [--release-notes-en docs/release-notes/v0.1.0.en-US.md]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const REWRITE_LINE = /^(\s*(?:-\s+)?)(url|path):\s*(["']?)(.*?)\3\s*$/;

function toAbsoluteAssetUrl(value, base) {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    // 已是绝对 URL（未来 builder 直接产出绝对地址时）原样保留。
    return trimmed;
  }
  const encoded = encodeURI(trimmed);
  return `${base.replace(/\/+$/, "")}/${encoded}`;
}

/**
 * markdown → YAML block scalar（|2 缩进指示符，内容整体缩进两格）。
 * 归一化：\r\n → \n、行尾空白去除、行首 tab 折算两空格（YAML block scalar 禁 tab 缩进）。
 * 空行保持真空行（block scalar 允许，无需缩进）。
 */
function toYamlBlockScalar(markdown) {
  const lines = markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, "").replace(/^\t+/, "  "));
  return ["releaseNotes: |-", ...lines.map((line) => (line.length > 0 ? `  ${line}` : ""))].join(
    "\n",
  );
}

/** 英文说明注入 releaseNotesByLocale（zh-CN/en-US 两键；title 由客户端按首个 # 标题自动派生）。 */
function toYamlLocalizedBlockScalar({ enMarkdown, zhMarkdown }) {
  return [
    "releaseNotesByLocale:",
    "  zh-CN:",
    "    markdown: |-",
    ...zhMarkdown.split("\n").map((line) => (line.length > 0 ? `      ${line}` : "")),
    "  en-US:",
    "    markdown: |-",
    ...enMarkdown.split("\n").map((line) => (line.length > 0 ? `      ${line}` : "")),
  ].join("\n");
}

async function main() {
  // 选项名用 kebab-case：CI 调用按 --out-root 传参；node:util parseArgs 的选项键
  // 是字面量匹配，camelCase 键会报 ERR_PARSE_ARGS_UNKNOWN_OPTION（v0.0.1 首跑实测教训）。
  const { values } = parseArgs({
    options: {
      manifest: { type: "string", required: true },
      platform: { type: "string", required: true },
      base: { type: "string", required: true },
      "out-root": { type: "string", required: true },
      "release-notes": { type: "string" },
      "release-notes-en": { type: "string" },
    },
  });
  const outRoot = values["out-root"];

  const source = resolve(values.manifest);
  const raw = await readFile(source, "utf8");
  const lines = raw.split("\n");
  let rewritten = 0;
  const outputLines = lines.map((line) => {
    const match = line.match(REWRITE_LINE);
    if (!match) return line;
    const [, indent, key, quote, value] = match;
    if (!value) return line;
    rewritten += 1;
    return `${indent}${key}: ${quote}${toAbsoluteAssetUrl(value, values.base)}${quote}`;
  });
  if (rewritten === 0) {
    throw new Error(`清单里没有可改写的 url/path 字段，格式可能已变化: ${source}`);
  }

  // 更新说明注入：清单文件缺失时跳过（不注入 = 弹窗无说明区块，与既有发布形态一致）。
  const zhNotesPath = values["release-notes"];
  const enNotesPath = values["release-notes-en"];
  const enMarkdown = enNotesPath
    ? (await readFile(resolve(enNotesPath), "utf8")).trim()
    : undefined;
  if (zhNotesPath) {
    const zhMarkdown = (await readFile(resolve(zhNotesPath), "utf8")).trim();
    if (zhMarkdown.length === 0) {
      throw new Error(`release notes file is empty: ${zhNotesPath}`);
    }
    if (raw.includes("releaseNotes:")) {
      throw new Error(
        `manifest already contains releaseNotes; refusing to double-inject: ${source}`,
      );
    }
    outputLines.push(toYamlBlockScalar(zhMarkdown));
    if (enMarkdown !== undefined && enMarkdown.length > 0) {
      outputLines.push(toYamlLocalizedBlockScalar({ enMarkdown, zhMarkdown }));
    }
  }

  // 落位文件名统一为 latest.yml（客户端静态 feed 固定请求该文件名）。
  const target = resolve(outRoot, values.platform, "latest.yml");
  await mkdir(resolve(outRoot, values.platform), { recursive: true });
  await writeFile(target, `${outputLines.join("\n")}`, "utf8");
  console.log(
    `[rewrite-update-manifests] ${source} -> ${target} (rewritten=${rewritten}` +
      `${zhNotesPath ? ", releaseNotes=zh-CN" : ""}${enMarkdown ? "+en-US" : ""})`,
  );
}

await main();
