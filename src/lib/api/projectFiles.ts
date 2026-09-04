import { invoke } from "@tauri-apps/api/core";

/** 目录单层条目（rel 为项目内相对路径，posix 风格） */
export interface ProjectDirEntry {
  name: string;
  rel: string;
  isDir: boolean;
}

/** git status --porcelain 解析结果 */
export interface GitStatusEntry {
  raw: string;
  path: string;
}

export interface GitStatusResult {
  git: boolean;
  entries: GitStatusEntry[];
  error?: string;
}

export interface GitDiffResult {
  git: boolean;
  diff: string;
  untracked?: boolean;
  content?: string;
  error?: string;
}

/** 项目文件浏览 / 在线编辑 / Git 差异 API（后端：api-backend.mjs） */
export const projectFilesApi = {
  async listDir(root: string, rel = ""): Promise<ProjectDirEntry[]> {
    return invoke<ProjectDirEntry[]>("list_project_dir", { root, rel });
  },

  async readFile(filePath: string): Promise<string> {
    return invoke<string>("read_project_file", { path: filePath });
  },

  async writeFile(filePath: string, content: string): Promise<boolean> {
    return invoke<boolean>("write_project_file", {
      path: filePath,
      content,
    });
  },

  async gitStatus(root: string): Promise<GitStatusResult> {
    return invoke<GitStatusResult>("git_status", { root });
  },

  async gitDiff(
    root: string,
    filePath?: string,
  ): Promise<GitDiffResult> {
    return invoke<GitDiffResult>("git_diff", {
      root,
      path: filePath ?? null,
    });
  },
};