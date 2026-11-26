import {
  formatOpsEntryId,
  opsPanelEntrySchema,
  opsPanelQueueViewSchema,
  type OpsPanelEntry,
  type OpsPanelView,
} from "./contract.js";

/** ops-panel 模块边界示例：编号分配 + 条目 schema 解析 + 队列视图投影。 */
export const exampleRequirementId: string = formatOpsEntryId("requirement", 1);

export const exampleEntry: OpsPanelEntry = opsPanelEntrySchema.parse({
  kind: "requirement",
  id: exampleRequirementId,
  title: "Fix landing page",
  body: "The hero banner overlaps the nav bar.",
  author: "user",
  // 2026-11-24 录入与来源拆分：master 对话代录（author=来源 user、recordedBy=经手）。
  recordedBy: "master",
  status: "submitted",
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
});

export const exampleView: OpsPanelView = {
  entries: [exampleEntry],
  queue: opsPanelQueueViewSchema.parse({
    inFlightId: exampleRequirementId,
    pendingIds: [],
  }),
};
