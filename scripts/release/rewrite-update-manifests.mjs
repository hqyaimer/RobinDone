#!/usr/bin/env node
// RobinRun 发布工程：把 electron-builder 生成的 latest*.yml 更新清单改写为静态 feed 形态。
//
// 两个职责：
// 1. 清单里的相对文件名（url/path 字段）改写为指向 GitHub Release 附件的绝对 URL——
//    客户端静态 feed 从 raw.githubusercontent.com 读 yml，但安装包在 Release 附件上，
//    相对路径会错误解析到 raw 的 origin 根（manifestUpdateProvider.resolveBaseUrl 语义）。
// 2. 平台目录落位：客户端静态清单地址固定为 "{base}/{releasePlatform}/latest.yml"
//    （见 manifestUpdateProvider.ts resolveStaticManifestBase / buildElectronManifestUrl），
//    所以无论源文件叫 latest.yml / latest-mac.yml / latest-linux.yml，落位后统一叫 latest.yml。
//
// 文本级逐行替换而非 YAML round-trip：electron-builder 生成的清单是稳定的平铺格式，
// 文本替换可原样保留其余字段与格式，避免解析器重排/引号漂移引入的意外 diff。
// 用法（CI release job 每平台调一次）：
//   node scripts/release/rewrite-update-manifests.mjs \
//     --manifest artifacts/dist-win-x64/latest.yml \
//     --platform windows-x86_64 \
//     --base https://github.com/<owner>/<repo>/releases/download/v0.1.0 \
//     --out-root updates-staging
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

async function main() {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string", required: true },
      platform: { type: "string", required: true },
      base: { type: "string", required: true },
      outRoot: { type: "string", required: true },
    },
  });

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

  // 落位文件名统一为 latest.yml（客户端静态 feed 固定请求该文件名）。
  const target = resolve(values.outRoot, values.platform, "latest.yml");
  await mkdir(resolve(values.outRoot, values.platform), { recursive: true });
  await writeFile(target, `${outputLines.join("\n")}`, "utf8");
  console.log(`[rewrite-update-manifests] ${source} -> ${target} (rewritten=${rewritten})`);
}

await main();
