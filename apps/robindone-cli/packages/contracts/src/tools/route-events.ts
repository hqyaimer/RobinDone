// ============================================================
// RouteEvents Tool - dispatcher topic routing (dispatcher sessions only)
// ============================================================
// 2026-11-25 分发器裁决（specs/trigger-dispatcher-routing.md）：dispatcher 档触发器的
// 绑定会话是分发器——职责只有话题聚类分箱，不做业务处理。本工具是**引用式标记**：
// 模型按事件 id 声明路由目标，事件原文由机制层（引擎 RouteMarkQueue → host）直传目标
// 会话，不经分发器的手转述（裁决 5：不复制不转述，杜绝上下文与工具参数双份冗余）。
// 与 ContactAgent 的语义区别：ContactAgent 是内容传递（message 进工具参数），本工具是
// 引用标记。路由目标恒为订阅者（创建者）本人的会话（裁决 1 的机制层校验在引擎）；
// 标记在分发器轮次结束（空闲）后统一兑现拆批投递。非分发器会话调用被引擎拒绝
// （会话 key 反查 + routing 门控）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const ROUTE_EVENTS_TOOL_NAME = "RouteEvents";

const routeTargetSchema = z.union([
  z
    .object({
      kind: z.literal("new").describe("Start a new session owned by you (the subscriber)."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("existing").describe("Continue an existing session you previously routed to."),
      taskId: z.string().min(1).describe("Session id of the existing topic session (from this conversation)."),
    })
    .strict(),
]);

export const RouteEventsInputSchema = z
  .object({
    routes: z
      .array(
        z
          .object({
            /** 引用的事件 id（本轮投递正文里的 [evt-*]）；内容不进工具参数——机制层直传原文。 */
            eventIds: z.array(z.string().min(1)).min(1).max(64),
            target: routeTargetSchema,
          })
          .strict(),
      )
      .min(1)
      .max(16)
      .describe(
        "Routing decisions for this delivery's events. One entry per target; events sharing a target are merged into one delivery.",
      ),
  })
  .strict()
  .describe(
    "Mark routing decisions for the events delivered to this dispatcher session. Call this once per delivery after deciding each event's topic; marks are delivered after your turn ends (the original event payloads are forwarded verbatim to the target sessions). Be conservative: when unsure whether an event belongs to an existing topic, route it to a NEW session. Do not restate event content in this call.",
  );

export type RouteEventsInput = z.infer<typeof RouteEventsInputSchema>;

export const RouteEventsOutputSchema = z
  .object({
    ok: z.boolean(),
    /** 已接受登记的事件 id（将在本轮结束后兑现投递）。 */
    acceptedEventIds: z.array(z.string()),
    /**
     * 未被接受的事件 id：不在分发器事件池（已按漏标降级直投、或非本分发器批次的事件）。
     * unknown ≠ 失败——事件已另有去向，无需重试。
     */
    unknownEventIds: z.array(z.string()),
    warnings: z.array(z.string()).optional(),
  })
  .strict();
export type RouteEventsOutput = z.infer<typeof RouteEventsOutputSchema>;

export const RouteEventsInputJsonSchema = toToolJsonSchema(RouteEventsInputSchema);
export const RouteEventsOutputJsonSchema = toToolJsonSchema(RouteEventsOutputSchema);
