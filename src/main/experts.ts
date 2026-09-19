// 专家（角色模式，对应 PRD 3.10）：人设 + 业务资源白名单（SKILL / MCP / 知识库）
// 规则：基座提示词不被专家覆盖；基础工具能力各专家完全一致（不做工具约束）；
// 差异化只在 rolePrompt（人设）与三类资源白名单——白名单只能收窄不能扩展（null = 不收窄）
import type { Audit } from "./audit";

export interface ExpertDef {
  id: string;
  name: string;
  description: string;
  /** 人设：追加在基座提示词之上的角色提示词 */
  rolePrompt: string;
  /** 技能白名单：null = 继承全部已启用技能；[] = 不挂任何技能 */
  skillWhitelist: string[] | null;
  /** MCP 连接器白名单（一期未接入，管理端配置先行） */
  mcpWhitelist: string[] | null;
  /** 知识库白名单（一期未接入，管理端配置先行） */
  kbWhitelist: string[] | null;
}

export interface ExpertInfo {
  id: string;
  name: string;
  description: string;
  skillWhitelist: string[] | null;
  mcpWhitelist: string[] | null;
  kbWhitelist: string[] | null;
}

export class ExpertRegistry {
  constructor(
    private items: ExpertDef[],
    private defaultId: string
  ) {}

  list(): ExpertInfo[] {
    return this.items.map(({ id, name, description, skillWhitelist, mcpWhitelist, kbWhitelist }) => ({
      id,
      name,
      description,
      skillWhitelist,
      mcpWhitelist,
      kbWhitelist,
    }));
  }

  byId(id: string): ExpertDef | undefined {
    return this.items.find((e) => e.id === id);
  }

  get defaultExpert(): ExpertDef {
    return this.byId(this.defaultId) ?? this.items[0];
  }

  // 技能白名单解析：null = 不收窄（全部）；[] = 空集（不挂任何技能）
  allowedSkills(expert: ExpertDef): Set<string> | null {
    if (expert.skillWhitelist === null) return null;
    return new Set(expert.skillWhitelist);
  }

  // MCP 连接器白名单解析：口径同技能（null = 全部；[] = 不挂任何连接器）
  allowedConnectors(expert: ExpertDef): Set<string> | null {
    if (expert.mcpWhitelist === null) return null;
    return new Set(expert.mcpWhitelist);
  }

  // 知识库白名单解析：只约束企业库——个人库是用户私有数据不受限（PRD 3.10/4.5）
  allowedKnowledgeBases(expert: ExpertDef): Set<string> | null {
    if (expert.kbWhitelist === null) return null;
    return new Set(expert.kbWhitelist);
  }

  static auditSwitch(audit: Audit, from: string, to: string): void {
    audit.append({ event: "expert_switch", from, to });
  }
}
