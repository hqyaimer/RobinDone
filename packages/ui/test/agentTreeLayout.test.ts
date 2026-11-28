import { describe, expect, it } from "vitest";
import { buildAgentTreeLayout } from "@/project-sidebar/grouped/model.js";
import { UNGROUPED_AGENT_ID } from "@/project-sidebar/grouped/ids.js";
import type { ProjectTask, TaskGroup, VirtualProject } from "@/project-sidebar/contract.js";
import type { RobinDoneGroupedTaskView } from "@/project-sidebar/grouped/types.js";

function project(id: string, name: string): VirtualProject {
  return {
    id,
    hostId: "local",
    name,
    nameOverridden: false,
    roots: [{ rootPath: `C:/ws/${name}`, isPrimary: true }],
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

function group(id: string, projectId: string | null): TaskGroup {
  return { id, title: id, color: "gray", projectId, createdAt: 0, updatedAt: 0 };
}

function view(groups: Array<[id: string, projectId: string | null]>): RobinDoneGroupedTaskView {
  return {
    nodes: groups.map(([id, projectId]) => ({
      type: "group" as const,
      group: group(id, projectId),
      tasks: [] as ProjectTask[],
    })),
  };
}

const layoutGroupIds = (layout: ReturnType<typeof buildAgentTreeLayout>) => ({
  sections: layout.sections.map((section) => ({
    project: section.project.id,
    agents: section.agents.map((agent) => agent.group.id),
  })),
  unbound: layout.unbound.map((agent) => agent.group.id),
  ungrouped: layout.ungrouped?.group.id ?? null,
});

// 2026-11-15 智能体页数据范围裁决：删除 Test 项目后新建 Test2，已删项目的组不得
// 以"未绑定"的形态泄漏进其他项目的智能体页（用户验收反馈）。
describe("buildAgentTreeLayout scopeProject", () => {
  const test2 = project("proj-test2", "Test2");
  const ungrouped: [string, string | null] = [UNGROUPED_AGENT_ID, null];

  it("树模式（不传 scope）保持全量：已删除项目与未绑定的组都渲染在未绑定区", () => {
    const layout = buildAgentTreeLayout(
      view([["g-test2", "proj-test2"], ["g-deleted", "proj-test"], ["g-unbound", null], ungrouped]),
      [test2],
    );
    expect(layoutGroupIds(layout)).toEqual({
      sections: [{ project: "proj-test2", agents: ["g-test2"] }],
      unbound: ["g-deleted", "g-unbound"],
      ungrouped: UNGROUPED_AGENT_ID,
    });
  });

  it("智能体页模式：绑定其他项目（含已删除）的组整段隐藏，未绑定组保留", () => {
    const layout = buildAgentTreeLayout(
      view([
        ["g-test2", "proj-test2"],
        ["g-deleted", "proj-test"],
        ["g-alive", "proj-test3"],
        ["g-unbound", null],
        ungrouped,
      ]),
      [test2],
      test2,
    );
    expect(layoutGroupIds(layout)).toEqual({
      sections: [{ project: "proj-test2", agents: ["g-test2"] }],
      unbound: ["g-unbound"],
      ungrouped: UNGROUPED_AGENT_ID,
    });
  });

  it("未分组伪组按 id 识别，不因 projectId 为空落入未绑定区", () => {
    const layout = buildAgentTreeLayout(view([ungrouped]), [test2], test2);
    expect(layout.unbound).toEqual([]);
    expect(layout.ungrouped?.group.id).toBe(UNGROUPED_AGENT_ID);
  });
});
