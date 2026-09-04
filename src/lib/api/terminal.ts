import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  CreateTerminalPayload,
  EmbeddedOutputEvent,
  TerminalHubState,
  TerminalLaunchConfig,
  ToolSessionInfo,
} from "@/types/terminal";

export const terminalApi = {
  /** 当前平台可用的终端 id 列表 */
  async detectAvailable(): Promise<string[]> {
    return invoke<string[]>("detect_available_terminals");
  },

  /** 拉起原生终端，返回可管理的 PID */
  async launch(config: TerminalLaunchConfig): Promise<number> {
    return invoke<number>("launch_terminal", { config });
  },

  /** 终止终端及其子进程树 */
  async kill(pid: number): Promise<void> {
    return invoke<void>("kill_terminal", { pid });
  },

  async checkAlive(pid: number): Promise<boolean> {
    return invoke<boolean>("check_terminal_alive", { pid });
  },

  /** 把已运行的终端窗口带到前台；窗口已关闭等无法聚焦时返回 false */
  async focus(pid: number): Promise<boolean> {
    return invoke<boolean>("focus_terminal", { pid });
  },

  /** 幂等打开内嵌终端：同一实例已有存活会话则复用，否则新建。返回会话 pty id */
  async ensureEmbedded(config: TerminalLaunchConfig): Promise<number> {
    return invoke<number>("ensure_embedded_terminal", { config });
  },

  /**
   * 连接内嵌终端会话：先回放输出历史，再订阅实时输出。
   * 断开连接（Channel 关闭）不影响会话存活，重新连接即可恢复显示。
   */
  async attachEmbedded(
    ptyId: number,
    onEvent: (evt: EmbeddedOutputEvent) => void,
  ): Promise<void> {
    const channel = new Channel<EmbeddedOutputEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("attach_embedded_terminal", {
      ptyId,
      onData: channel,
    });
  },

  /** 向内嵌终端写入输入 */
  async writeEmbedded(ptyId: number, data: string | Uint8Array): Promise<void> {
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : Array.from(data);
    return invoke<void>("write_embedded_terminal", {
      ptyId,
      data: Array.from(bytes),
    });
  },

  async resizeEmbedded(
    ptyId: number,
    cols: number,
    rows: number,
  ): Promise<void> {
    return invoke<void>("resize_embedded_terminal", {
      ptyId,
      cols,
      rows,
    });
  },

  async closeEmbedded(ptyId: number): Promise<void> {
    return invoke<void>("close_embedded_terminal", { ptyId });
  },

  async getState(): Promise<TerminalHubState> {
    return invoke<TerminalHubState>("get_terminal_hub_state");
  },

  async saveState(state: TerminalHubState): Promise<void> {
    return invoke<void>("save_terminal_hub_state", { state });
  },

  async createInstance(
    payload: CreateTerminalPayload,
  ): Promise<TerminalHubState> {
    return invoke<TerminalHubState>("create_terminal_instance", {
      name: payload.name,
      app: payload.app,
      projectDir: payload.projectDir,
      tool: payload.tool,
      projectId: payload.projectId ?? null,
      customCommand: payload.customCommand ?? null,
      args: payload.args ?? null,
      terminal: payload.terminal ?? null,
    });
  },

  async deleteInstance(id: string): Promise<TerminalHubState> {
    return invoke<TerminalHubState>("delete_terminal_instance", { id });
  },

  /** 获取工具本机会话上下文（Claude Code / OpenCode），用于快速恢复会话 */
  async listToolSessions(
    tool: string,
    projectDir?: string,
  ): Promise<ToolSessionInfo[]> {
    return invoke<ToolSessionInfo[]>("list_tool_sessions", {
      tool,
      projectDir: projectDir ?? null,
    });
  },

  /** 用当前供应商 API 润色提示词（供终端弹出输入使用） */
  async polishPrompt(app: string, text: string): Promise<string> {
    return invoke<string>("polish_prompt", { app, text });
  },

  /** 查询当前调用模型的实时速率（tokens/sec） */
  async getModelRate(): Promise<ModelRateInfo> {
    return invoke<ModelRateInfo>("get_model_rate");
  },
};

/** 模型实时速率信息 */
export interface ModelRateInfo {
  /** 窗口内的平均输出速率（tokens/sec） */
  tokensPerSecond: number;
  /** 窗口内累计输出 token 数 */
  outputTokens: number;
  /** 窗口实际覆盖秒数（无样本时为 0） */
  sampleSeconds: number;
  /** 最近一次请求的模型名 */
  lastModel?: string | null;
}
