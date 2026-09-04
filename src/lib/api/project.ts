import { invoke } from "@tauri-apps/api/core";

/** 项目快照信息：创建项目时保存的 Claude 配置 */
export interface ProjectSnapshot {
  mcp: boolean;
  skills: number;
  memory: boolean;
}

/** 项目中的工具绑定：app → 供应商 */
export type ProjectTools = Record<
  string,
  { providerId: string; args?: string }
>;

/** 开发项目 */
export interface DevProject {
  id: string;
  name: string;
  projectDir: string;
  tools: ProjectTools;
  createdAt: number;
  updatedAt: number;
}

/** 项目详情：各工具的可用供应商与当前绑定 */
export interface ProjectDetail extends DevProject {
  apps: Record<
    string,
    { providers: Array<{ id: string; name: string; category: string }>; boundProviderId: string | null }
  >;
}

export interface ApplyProjectResult {
  success: boolean;
  warnings: string[];
  results: Record<string, { ok: boolean; error?: string }>;
  snapshot: ProjectSnapshot;
}

export const projectApi = {
  async list(): Promise<DevProject[]> {
    return invoke<DevProject[]>("list_projects");
  },

  async create(args: {
    name: string;
    projectDir: string;
    tools: ProjectTools;
  }): Promise<DevProject> {
    return invoke<DevProject>("create_project", args);
  },

  async remove(id: string): Promise<boolean> {
    return invoke<boolean>("delete_project", { id });
  },

  async detail(id: string): Promise<ProjectDetail> {
    return invoke<ProjectDetail>("get_project_detail", { id });
  },

  async apply(id: string): Promise<ApplyProjectResult> {
    return invoke<ApplyProjectResult>("apply_project", { id });
  },
};