import { useEffect, useState } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

/**
 * python 主运行时供给进度（2026-11-26 打包内置改造，docs/trigger-python-runtime.md
 * §3.1）：host 侧触发器引擎挂载预热/按需 ensure 时经 `state:trigger-python-runtime`
 * 广播上抛，UI 订阅刷新设置页状态卡。
 *
 * payload 是本地结构镜像（ui-implementation-import 纪律：UI 不 import services 实现
 * 包，形状对齐 python-runtime.ts 的 PythonRuntimeProgressEvent）。
 *
 * 广播是瞬态推送，没有可回读的快照服务；模块级缓存最近一帧，设置页晚开也能显示
 * 启动期已收口的状态（首次打开且无任何事件 = 引擎未挂载/尚未触发 ensure，显示待检测）。
 */
export type TriggerPythonRuntimeStatus =
  | { kind: "unknown" }
  | { kind: "probing" }
  | { kind: "downloading"; downloadedBytes: number; totalBytes: number | null }
  | { kind: "available"; source: "managed" | "system" }
  | { kind: "unavailable"; error: string };

interface PythonRuntimeProgressEventLike {
  kind: "probing" | "downloading" | "available" | "unavailable";
  workspacePath?: string;
  downloadedBytes?: number;
  totalBytes?: number | null;
  source?: string;
  error?: string;
}

/** 模块级最近一帧缓存：设置页晚开晚关也能看到启动期状态，进程内有效。 */
let lastEvent: TriggerPythonRuntimeStatus = { kind: "unknown" };

export function useTriggerPythonRuntimeStatus(): TriggerPythonRuntimeStatus {
  const services = useBaseWorkspaceServices();
  const [status, setStatus] = useState<TriggerPythonRuntimeStatus>(lastEvent);

  useEffect(() => {
    const subscription = services.broadcastService.onMessage((event) => {
      if (event.channel !== "state:trigger-python-runtime") return;
      const payload = event.payload as PythonRuntimeProgressEventLike | undefined;
      if (!payload || typeof payload.kind !== "string") return;
      let next: TriggerPythonRuntimeStatus;
      switch (payload.kind) {
        case "probing":
          next = { kind: "probing" };
          break;
        case "downloading":
          next = {
            kind: "downloading",
            downloadedBytes:
              typeof payload.downloadedBytes === "number" && payload.downloadedBytes >= 0
                ? payload.downloadedBytes
                : 0,
            totalBytes:
              typeof payload.totalBytes === "number" && payload.totalBytes > 0
                ? payload.totalBytes
                : null,
          };
          break;
        case "available":
          next = { kind: "available", source: payload.source === "system" ? "system" : "managed" };
          break;
        case "unavailable":
          next = {
            kind: "unavailable",
            error:
              typeof payload.error === "string" && payload.error.trim().length > 0
                ? payload.error
                : "unknown error",
          };
          break;
        default:
          return;
      }
      lastEvent = next;
      setStatus(next);
    });
    return () => {
      subscription.dispose();
    };
  }, [services.broadcastService]);

  return status;
}
