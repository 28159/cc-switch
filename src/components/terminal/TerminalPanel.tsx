import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  TerminalSquare,
  Square,
  Trash2,
  Plus,
  FolderKanban,
  Loader2,
  ChevronRight,
  ChevronDown,
  RotateCcw,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  Gauge,
  Play,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { APP_ICON_MAP, getAppLabel } from "@/config/appConfig";
import { settingsApi, terminalApi, type AppId } from "@/lib/api";
import type { ModelRateInfo } from "@/lib/api/terminal";
import { projectApi, type DevProject } from "@/lib/api/project";
import {
  useTerminalHub,
  type TerminalAliveStatus,
} from "@/hooks/useTerminalHub";
import { NewTerminalDialog } from "./NewTerminalDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { ProjectFileBrowser } from "./ProjectFileBrowser";
import {
  TERMINAL_TOOL_LABEL,
  type TerminalInstance,
  type TerminalTool,
  type ToolSessionInfo,
} from "@/types/terminal";
import { cn } from "@/lib/utils";

/** 内嵌终端（xterm.js）懒加载：避免测试环境与首屏加载 xterm */
const EmbeddedTerminalLazy = lazy(() =>
  import("./EmbeddedTerminal").then((module) => ({
    default: module.EmbeddedTerminal,
  })),
);

/** 支持「最近会话」恢复的工具（启动参数里注入 resume/session 标记）。 */
const SESSION_TOOLS: TerminalTool[] = ["claude", "opencode"];

/** 工具 → 会话恢复参数名。 */
const SESSION_ARG_FLAG: Partial<Record<TerminalTool, string>> = {
  claude: "--resume",
  opencode: "--session",
};

/** 需要从参数里剔除的旧会话标记（避免与新的 --resume/--session 冲突）。 */
const SESSION_ARG_TOKENS = new Set([
  "--resume",
  "--session",
  "--continue",
  "-c",
  "-r",
]);

/** 在参数串里替换/追加会话标记。 */
function mergeSessionArg(
  current: string,
  tool: TerminalTool,
  sessionId: string,
): string {
  const flag = SESSION_ARG_FLAG[tool] ?? "--resume";
  const tokens = current.split(/\s+/).filter(Boolean);
  const next: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (SESSION_ARG_TOKENS.has(token)) {
      // 跳过标记及其值
      i += 1;
      continue;
    }
    next.push(token);
  }
  next.push(flag, sessionId);
  return next.join(" ");
}

/** 会话时间展示：MM-DD HH:mm */
function formatSessionTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 实例存活状态：内嵌会话（后端 PTY）优先，其次系统终端 pid 轮询结果。 */
function instanceAliveStatus(
  instance: TerminalInstance,
  hub: ReturnType<typeof useTerminalHub>,
): TerminalAliveStatus | "stopped" {
  const embeddedOk =
    typeof hub.embeddedPty[instance.id] === "number" &&
    !hub.embeddedExit[instance.id];
  if (embeddedOk) return "running";
  if (typeof instance.pid === "number") {
    return hub.alive[instance.id] === "running" ? "running" : "stopped";
  }
  return "stopped";
}

export interface TerminalPanelProps {
  /** 当前选中的应用 id（决定新建终端时默认注入哪套环境变量） */
  activeApp: AppId;
  /** 各 AI 工具的启动参数模板（来自设置） */
  launchTemplates?: Partial<Record<TerminalTool, string>>;
  /** 右侧栏内容（模型/供应商列表），full 模式下渲染在终端最右侧 */
  rightPanel?: React.ReactNode;
  /** 紧凑模式（HUD 小窗）：左栏收窄，给终端留更多空间 */
  compact?: boolean;
  /** HUD 窗口模式：左栏标题栏作为窗口拖拽区 */
  hudDraggable?: boolean;
  /** HUD 拖拽区鼠标按下回调 */
  onHeaderDragStart?: (event: React.MouseEvent) => void;
  /** 仅选择模式（HUD 小窗）：项目点击只应用/选择，不展开文件树 */
  selectOnly?: boolean;
}

/** 左栏宽度（项目树 + 终端列表） */
const LEFT_WIDTH = 250;
/** 紧凑模式左栏宽度（HUD 小窗） */
const COMPACT_LEFT_WIDTH = 175;
/** 左栏折叠后宽度 */
const COLLAPSED_LEFT_WIDTH = 32;
/** 右侧栏宽度（模型列表） */
const RIGHT_WIDTH = 380;
/** 左栏折叠状态持久化 key */
const LEFT_COLLAPSED_KEY = "cc-switch-terminal-left-collapsed";
/** 选中终端持久化 key */
const SELECTED_STORAGE_KEY = "cc-switch-terminal-selected";
/** 选中项目持久化 key */
const PROJECT_STORAGE_KEY = "cc-switch-terminal-project";

/**
 * 终端工作台（主页面三栏式布局）：
 * - 左栏：上半项目树 + 下半终端列表；
 * - 中栏：终端工作区（点击打开系统原生终端窗口）；
 * - 右栏：模型列表（供应商列表，由 rightPanel 注入）；
 * - 选中终端、终端实例均持久化保存。
 */
export function TerminalPanel({
  activeApp,
  launchTemplates,
  rightPanel,
  compact = false,
  hudDraggable = false,
  selectOnly = false,
  onHeaderDragStart,
}: TerminalPanelProps) {
  const { t } = useTranslation();
  const hub = useTerminalHub();

  const [newOpen, setNewOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(LEFT_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [confirmDelete, setConfirmDelete] = useState<TerminalInstance | null>(
    null,
  );
  /** 删除进行中的实例 id（确认对话框 pending 态，避免重复点击） */
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** 清除会话重新初始化进行中的实例 id（重置按钮 loading 态） */
  const [resettingId, setResettingId] = useState<string | null>(null);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        LEFT_COLLAPSED_KEY,
        leftCollapsed ? "1" : "0",
      );
    } catch {
      // 忽略
    }
  }, [leftCollapsed]);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(SELECTED_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  /** 开发项目：列表 + 当前选中（localStorage 记忆） */
  const [projects, setProjects] = useState<DevProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => {
      try {
        return window.localStorage.getItem(PROJECT_STORAGE_KEY);
      } catch {
        return null;
      }
    },
  );
  /** 项目树展开状态 */
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [confirmDeleteProject, setConfirmDeleteProject] =
    useState<DevProject | null>(null);
  /** 历史会话恢复下拉状态 */
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionList, setSessionList] = useState<ToolSessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  /** 当前调用模型的实时速率 */
  const [modelRate, setModelRate] = useState<ModelRateInfo | null>(null);
  /** 终端列表右键菜单 */
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    instance: TerminalInstance;
  } | null>(null);

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("blur", close);
    };
  }, []);

  // 实时速率轮询
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const rate = await terminalApi.getModelRate();
        if (!cancelled) setModelRate(rate);
      } catch {
        // 后端尚未就绪，忽略本轮
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const selectedProject =
    projects.find((item) => item.id === selectedProjectId) ?? null;

  const effectiveApp: AppId =
    activeApp === "claude-desktop" ? "claude" : activeApp;
  const appLabel = getAppLabel(effectiveApp);

  const instances = hub.state.instances;
  /** 终端以项目为准：有选中项目时只显示该项目绑定的实例（兼容未绑定的旧实例） */
  const visibleInstances = selectedProject
    ? instances.filter(
        (item) => item.projectId === selectedProject.id || !item.projectId,
      )
    : instances;
  const selected =
    visibleInstances.find((item) => item.id === selectedId) ??
    visibleInstances[0] ??
    null;

  // 选中终端持久化；列表变化时保证选中有效。
  // 注意：启动时 instances 先空后加载，空窗期不要清除已持久化的选中，等实例到位后再校验。
  useEffect(() => {
    if (visibleInstances.length === 0) return;
    if (!visibleInstances.some((item) => item.id === selectedId)) {
      setSelectedId(visibleInstances[0].id);
      hub.setActiveInstanceId(visibleInstances[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleInstances, selectedId]);

  // 把当前选中写入 localStorage
  useEffect(() => {
    if (selected) {
      try {
        window.localStorage.setItem(SELECTED_STORAGE_KEY, selected.id);
      } catch {
        // 忽略
      }
    }
  }, [selected]);

  // 当前选中终端是否处于活跃会话（系统终端 pid 存活 或 内嵌 PTY 未退出）
  const activeRunning = Boolean(selected) && hub.instanceActive(selected.id);

  const handleBrowse = async (): Promise<string | null> => {
    try {
      const dir = await settingsApi.pickDirectory(hub.state.lastProjectDir);
      if (dir) hub.selectProjectDir(dir);
      return dir;
    } catch (error) {
      toast.error(
        t("terminalHub.browseFailed", { defaultValue: "选择目录失败" }) +
          `: ${String(error)}`,
      );
      return null;
    }
  };

  /** 点击列表项：切换右侧显示；内嵌终端会随选中自动启动/恢复会话。 */
  const selectInstance = (instance: TerminalInstance) => {
    setSelectedId(instance.id);
    hub.setActiveInstanceId(instance.id);
  };

  // 项目列表加载
  const loadProjects = useCallback(async () => {
    try {
      const list = await projectApi.list();
      setProjects(list);
      setSelectedProjectId((prev) => {
        const valid =
          prev && list.some((item) => item.id === prev) ? prev : null;
        try {
          window.localStorage.setItem(PROJECT_STORAGE_KEY, valid ?? "");
        } catch {
          // 忽略
        }
        return valid;
      });
      setExpandedProjectIds((prev) => {
        const validIds = new Set(list.map((item) => item.id));
        const next = new Set<string>();
        prev.forEach((id) => {
          if (validIds.has(id)) next.add(id);
        });
        return next;
      });
    } catch (error) {
      console.error("[TerminalPanel] failed to load projects", error);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  /** 选择项目即一键切换（应用供应商 + 恢复 Claude 配置快照 + 加载项目终端）。 */
  const handleApplyProject = async (id: string) => {
    const project = projects.find((item) => item.id === id);
    if (!project || projectBusy) return;
    setProjectBusy(true);
    try {
      const result = await projectApi.apply(id);
      setSelectedProjectId(id);
      try {
        window.localStorage.setItem(PROJECT_STORAGE_KEY, id);
      } catch {
        // 忽略
      }
      hub.selectProjectDir(project.projectDir);
      // 加载该项目的终端：优先项目绑定实例，其次通用（未绑定）实例
      const all = hub.state.instances;
      const bound = all.filter((item) => item.projectId === project.id);
      const generic = all.filter((item) => !item.projectId);
      const target = bound[0] ?? generic[0] ?? null;
      if (target) {
        setSelectedId(target.id);
        hub.setActiveInstanceId(target.id);
      }
      const toolsLabel = Object.keys(project.tools ?? {})
        .map(getAppLabel)
        .join("、");
      const snapshot = result.snapshot;
      const parts: string[] = [];
      if (snapshot.mcp) parts.push("MCP");
      if (snapshot.skills > 0) parts.push(`Skills×${snapshot.skills}`);
      if (snapshot.memory) parts.push("CLAUDE.md");
      toast.success(
        t("project.applied", {
          name: project.name,
          tools: toolsLabel,
          config: parts.length > 0 ? parts.join("、") : "无快照",
          defaultValue: `已应用项目「{{name}}」：{{tools}}；已恢复 {{config}}`,
        }),
        { closeButton: true, duration: 4000 },
      );
      if (result.warnings.length > 0) {
        toast.warning(result.warnings.join("；"), { closeButton: true });
      }
    } catch (error) {
      toast.error(
        t("project.applyFailed", {
          error: String(error),
          defaultValue: "应用项目失败：{{error}}",
        }),
        { closeButton: true },
      );
    } finally {
      setProjectBusy(false);
    }
  };

  const handleDeleteProject = async () => {
    if (!confirmDeleteProject) return;
    try {
      await projectApi.remove(confirmDeleteProject.id);
      setConfirmDeleteProject(null);
      if (selectedProjectId === confirmDeleteProject.id) {
        setSelectedProjectId(null);
        try {
          window.localStorage.setItem(PROJECT_STORAGE_KEY, "");
        } catch {
          // 忽略
        }
      }
      await loadProjects();
      toast.success(
        t("project.deleted", {
          name: confirmDeleteProject.name,
          defaultValue: `项目「${confirmDeleteProject.name}」已删除`,
        }),
        { closeButton: true },
      );
    } catch (error) {
      toast.error(
        t("project.deleteFailed", {
          error: String(error),
          defaultValue: "删除项目失败：{{error}}",
        }),
        { closeButton: true },
      );
    }
  };

  const toggleProjectExpanded = (id: string) => {
    setExpandedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  /** 加载当前选中终端的历史会话列表（Claude Code / OpenCode）。 */
  const loadSessions = async (instance: TerminalInstance) => {
    if (!instance || !SESSION_TOOLS.includes(instance.tool)) return;
    setSessionsLoading(true);
    try {
      const list = await terminalApi.listToolSessions(
        instance.tool,
        instance.projectDir,
      );
      setSessionList(list);
    } catch (error) {
      console.error("[TerminalPanel] failed to load sessions", error);
      setSessionList([]);
      toast.error(
        t("terminalHub.sessionsLoadFailed", {
          error: String(error),
          defaultValue: "加载会话列表失败：{{error}}",
        }),
      );
    } finally {
      setSessionsLoading(false);
    }
  };

  /** 恢复到指定历史会话：更新启动参数并重新初始化终端。 */
  const handleResumeSession = async (session: ToolSessionInfo) => {
    if (!selected) return;
    setSessionsOpen(false);
    const args = mergeSessionArg(
      selected.args ?? "",
      selected.tool,
      session.sessionId,
    );
    hub.updateInstance(selected.id, { args });
    await hub.resetTerminal(selected.id);
    toast.success(
      t("terminalHub.sessionResumed", {
        defaultValue: "已恢复到会话（重启终端中…）",
      }),
    );
  };

  /** 清除会话并重新初始化：按钮 loading 态跟随，避免重复触发与无反馈卡顿。 */
  const handleResetTerminal = async (id: string) => {
    setResettingId(id);
    try {
      await hub.resetTerminal(id);
    } finally {
      setResettingId(null);
    }
  };

  /** 左栏：标题栏 + 项目树（上半）+ 终端列表（下半）；支持折叠为窄条 */
  const renderLeftPanel = () => {
    if (leftCollapsed) {
      return (
        <div
          className="flex shrink-0 flex-col items-center border-r border-border bg-background py-2"
          style={{ width: COLLAPSED_LEFT_WIDTH }}
        >
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setLeftCollapsed(false)}
            title={t("terminalHub.expandLeft", {
              defaultValue: "展开项目与终端",
            })}
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
          <span
            className="mt-2 text-[10px] font-medium text-muted-foreground"
            style={{ writingMode: "vertical-rl" }}
          >
            {t("terminalHub.projectsTerminals", {
              defaultValue: "项目 · 终端",
            })}
          </span>
        </div>
      );
    }

    return (
      <div
        className="flex shrink-0 flex-col border-r border-border bg-background"
        style={{ width: compact ? COMPACT_LEFT_WIDTH : LEFT_WIDTH }}
      >
        {/* 项目树（上半） */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
            {/* 项目标题（HUD 拖拽区） */}
            <span
              className="flex select-none items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
              {...(hudDraggable && onHeaderDragStart
                ? { onMouseDown: onHeaderDragStart }
                : {})}
            >
              <FolderKanban className="h-3 w-3" />
              {t("terminalHub.projects", { defaultValue: "项目" })}
            </span>
            <div className="flex items-center gap-0.5">
              {selectedProject && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-red-500"
                  title={t("project.delete", { defaultValue: "删除项目" })}
                  onClick={() => setConfirmDeleteProject(selectedProject)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                title={t("project.newDialog.title", {
                  defaultValue: "新建项目",
                })}
                onClick={() => setProjectDialogOpen(true)}
              >
                <Plus className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                onClick={() => setLeftCollapsed(true)}
                title={t("terminalHub.collapseLeft", {
                  defaultValue: "折叠左栏",
                })}
              >
                <PanelLeftClose className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {projects.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[11px] text-muted-foreground">
                {t("terminalHub.noProjects", {
                  defaultValue: "还没有项目，点击右上角 + 新建一个",
                })}
              </div>
            ) : (
              <div className="space-y-0.5">
                {projects.map((project) => {
                  const expanded = expandedProjectIds.has(project.id);
                  const isActive = selectedProject?.id === project.id;
                  const toolEntries = Object.entries(project.tools ?? {});
                  return (
                    <div
                      key={project.id}
                      className={cn(
                        "rounded-md transition-colors",
                        isActive ? "text-primary" : "hover:bg-muted/40",
                      )}
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => void handleApplyProject(project.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            void handleApplyProject(project.id);
                          }
                        }}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-1.5 px-1.5 py-1 text-left",
                          isActive && "font-medium",
                        )}
                        title={t("project.applyHint", {
                          name: project.name,
                          defaultValue: `应用项目「${project.name}」`,
                        })}
                      >
                        {!selectOnly && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleProjectExpanded(project.id);
                            }}
                            className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                            aria-label={t("terminalHub.toggleProjectTree", {
                              defaultValue: "展开或折叠项目",
                            })}
                          >
                            {expanded ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                          </button>
                        )}
                        <FolderKanban
                          className={cn(
                            "h-3.5 w-3.5 shrink-0",
                            projectBusy
                              ? "animate-spin text-primary"
                              : "text-muted-foreground",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">
                          {project.name}
                        </span>
                        {toolEntries.length > 0 && (
                          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                            {toolEntries.length}
                          </span>
                        )}
                      </div>
                      {expanded && !selectOnly && (
                        <div className="pb-1 pl-7 pr-1">
                          <p className="truncate font-mono text-[10px] text-muted-foreground/80">
                            {project.projectDir}
                          </p>
                          {toolEntries.length > 0 && (
                            <div className="mt-0.5 flex flex-wrap gap-1">
                              {toolEntries.map(([tool, binding]) => (
                                <span
                                  key={tool}
                                  className="rounded bg-muted/70 px-1.5 py-0.5 text-[9px] text-muted-foreground"
                                  title={`${binding.providerId}`}
                                >
                                  {getAppLabel(tool)}
                                  {binding.providerId
                                    ? ` · ${binding.providerId}`
                                    : ""}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="h-56">
                            <ProjectFileBrowser
                              projectDir={project.projectDir}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-border" />

        {/* 终端列表（下半） */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("terminalHub.instances", { defaultValue: "终端列表" })}
              {visibleInstances.length > 0
                ? ` (${visibleInstances.length})`
                : ""}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setNewOpen(true)}
              title={t("terminalHub.newTerminal", { defaultValue: "新建终端" })}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1.5 p-1.5">
              {visibleInstances.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[11px] text-muted-foreground">
                  {selectedProject
                    ? t("terminalHub.emptyForProject", {
                        name: selectedProject.name,
                        defaultValue:
                          "该项目下还没有终端，点击右上角 + 新建一个。",
                      })
                    : t("terminalHub.empty", {
                        defaultValue: "还没有终端，点击右上角 + 新建一个。",
                      })}
                </div>
              ) : (
                visibleInstances.map((instance) => {
                  const status = instanceAliveStatus(instance, hub);
                  const isSelected = selected?.id === instance.id;
                  const isContextTarget =
                    contextMenu?.instance.id === instance.id;
                  return (
                    <div
                      key={instance.id}
                      onClick={() => selectInstance(instance)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setContextMenu({
                          x: event.clientX,
                          y: event.clientY,
                          instance,
                        });
                      }}
                      className={cn(
                        "cursor-pointer rounded-lg border p-2 transition-colors",
                        isSelected
                          ? "border-primary/50 bg-primary/5"
                          : "border-border/60 bg-muted/30 hover:border-border",
                        isContextTarget && "border-border",
                      )}
                    >
                      <div className="flex items-start justify-between gap-1.5">
                        <div className="flex min-w-0 items-center gap-2">
                          {/* 应用 logo + 运行状态角标 */}
                          <div className="relative shrink-0">
                            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background/80">
                              {APP_ICON_MAP[instance.app as AppId]?.icon ?? (
                                <TerminalSquare className="h-4 w-4 text-muted-foreground" />
                              )}
                            </div>
                            <span
                              className={cn(
                                "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-background",
                                status === "running"
                                  ? "bg-emerald-500"
                                  : status === "idle"
                                    ? "bg-amber-400"
                                    : "bg-muted-foreground/40",
                              )}
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium">
                              {instance.name}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5">
                              <span className="text-[10px] font-medium text-foreground/80">
                                {TERMINAL_TOOL_LABEL[instance.tool]}
                              </span>
                              <span className="text-[9px] text-muted-foreground">
                                {status === "running"
                                  ? t("terminalHub.running", {
                                      defaultValue: "运行中",
                                    })
                                  : status === "idle"
                                    ? t("terminalHub.idle", {
                                        defaultValue: "空闲",
                                      })
                                    : t("terminalHub.stopped", {
                                        defaultValue: "已停止",
                                      })}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    );
  };

  /** 中栏：终端头部 + 终端主体 */
  const renderTerminalArea = () => (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      {/* 终端头部 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/50 px-2.5 py-1.5">
        {selected && (
          <span className="flex min-w-0 items-center gap-1.5 text-foreground">
            {APP_ICON_MAP[selected.app as AppId]?.icon}
            <span className="truncate text-xs font-medium">
              {selected.name}
            </span>
          </span>
        )}
        <span className="min-w-0 flex-1 truncate px-1 font-mono text-[10px] text-muted-foreground">
          {selected?.projectDir ?? appLabel}
        </span>
        {/* 当前调用模型的实时速率 */}
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground"
          title={
            modelRate && modelRate.outputTokens > 0
              ? `${modelRate.lastModel ?? "未知模型"} · 最近 ${modelRate.sampleSeconds}s 输出 ${modelRate.outputTokens} tokens`
              : "暂无模型调用流量（模型速率经本地代理统计）"
          }
        >
          <Gauge className="h-3 w-3 text-emerald-500/80" />
          {modelRate && modelRate.outputTokens > 0
            ? `${modelRate.tokensPerSecond.toFixed(1)} tok/s`
            : "-- tok/s"}
        </span>
        {selected && SESSION_TOOLS.includes(selected.tool) && (
          <DropdownMenu
            open={sessionsOpen}
            onOpenChange={(open) => {
              setSessionsOpen(open);
              if (open && selected) void loadSessions(selected);
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                title={t("terminalHub.resumeSession", {
                  defaultValue: "恢复历史会话",
                })}
              >
                <History className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="max-h-80 w-72 overflow-y-auto"
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("terminalHub.recentSessions", {
                  defaultValue: "历史会话（点击恢复）",
                })}
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-border" />
              {sessionsLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : sessionList.length === 0 ? (
                <p className="px-3 py-3 text-center text-[11px] text-muted-foreground">
                  {t("terminalHub.noSessions", {
                    defaultValue: "未找到可恢复的会话",
                  })}
                </p>
              ) : (
                sessionList.map((session) => (
                  <DropdownMenuItem
                    key={session.sessionId}
                    onSelect={() => void handleResumeSession(session)}
                    className="flex min-w-0 flex-col items-start gap-0.5"
                  >
                    <span className="max-w-full truncate text-xs text-foreground">
                      {session.title?.trim() || session.sessionId}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatSessionTime(session.lastActiveAt) ||
                        session.projectDir ||
                        ""}
                    </span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t("terminalHub.reset", {
            defaultValue: "清除会话并重新初始化（全新终端）",
          })}
          onClick={() => selected && void handleResetTerminal(selected.id)}
          disabled={resettingId !== null}
        >
          {resettingId === selected?.id ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t("terminalHub.stop", { defaultValue: "停止" })}
          onClick={() => selected && void hub.stopTerminal(selected.id)}
          disabled={!activeRunning}
        >
          <Square className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* 终端主体：面板内嵌 PTY 终端（xterm.js） */}
      <div className="min-h-0 flex-1 p-1">
        {selected ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                {t("terminalHub.loadingEmbedded", {
                  defaultValue: "正在启动终端…",
                })}
              </div>
            }
          >
            <EmbeddedTerminalLazy
              instance={selected}
              resetNonce={hub.resetNonce[selected.id] ?? 0}
              onPtyChange={(ptyId) => hub.registerEmbedded(selected.id, ptyId)}
              onExitChange={(exited) =>
                hub.setEmbeddedExited(selected.id, exited)
              }
            />
          </Suspense>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <TerminalSquare className="h-8 w-8 opacity-40" />
            <p className="px-6 text-center text-xs leading-relaxed">
              {t("terminalHub.emptyRight", {
                defaultValue: "点击左侧「新建终端」创建一个终端",
              })}
            </p>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* 主布局：三栏式终端工作台（左：项目树+终端列表 / 中：终端 / 右：模型列表） */}
      <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
        {renderLeftPanel()}
        {renderTerminalArea()}
        {/* 右栏：模型列表（供应商列表） */}
        {rightPanel && (
          <div
            className="flex shrink-0 flex-col border-l border-border bg-background"
            style={{ width: RIGHT_WIDTH }}
          >
            {rightPanel}
          </div>
        )}
      </div>

      {contextMenu &&
        (() => {
          const { x, y, instance } = contextMenu;
          const status = instanceAliveStatus(instance, hub);
          const menuWidth = 176;
          const menuHeight = 152;
          const left = Math.max(
            8,
            Math.min(x, window.innerWidth - menuWidth - 8),
          );
          const top = Math.max(
            8,
            Math.min(y, window.innerHeight - menuHeight - 8),
          );
          return (
            <div
              className="fixed z-50 w-44 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-xl"
              style={{ left, top }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  if (status === "running") {
                    void hub.focusTerminal(instance.id);
                  } else {
                    void hub.openTerminal(instance.id);
                  }
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted"
              >
                <Play className="h-3.5 w-3.5 text-muted-foreground" />
                {status === "running" ? "聚焦窗口" : "打开终端"}
              </button>
              <button
                type="button"
                disabled={status !== "running"}
                onClick={() => {
                  setContextMenu(null);
                  void hub.stopTerminal(instance.id);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-40"
              >
                <Square className="h-3.5 w-3.5 text-muted-foreground" />
                {t("terminalHub.stop", { defaultValue: "停止" })}
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  void handleResetTerminal(instance.id);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted"
              >
                <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                {t("terminalHub.reset", {
                  defaultValue: "重置会话",
                })}
              </button>
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  setConfirmDelete(instance);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-red-500 transition-colors hover:bg-red-500/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("terminalHub.delete", { defaultValue: "删除" })}
              </button>
            </div>
          );
        })()}

      {newOpen && (
        <NewTerminalDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          appId={effectiveApp}
          appLabel={appLabel}
          projectDirs={hub.state.projectDirs}
          defaultProjectDir={
            selectedProject?.projectDir ?? hub.state.lastProjectDir
          }
          projectId={selectedProject?.id}
          availableTerminals={hub.availableTerminals}
          launchTemplates={launchTemplates}
          onBrowse={() => handleBrowse()}
          onListSessions={(tool, projectDir) =>
            terminalApi.listToolSessions(tool, projectDir)
          }
          onSubmit={(payload) => hub.createTerminal(payload)}
        />
      )}

      {projectDialogOpen && (
        <NewProjectDialog
          open={projectDialogOpen}
          onOpenChange={setProjectDialogOpen}
          projectDirs={hub.state.projectDirs}
          defaultProjectDir={
            selectedProject?.projectDir ?? hub.state.lastProjectDir
          }
          onBrowse={() => handleBrowse()}
          onCreated={() => void loadProjects()}
        />
      )}

      <ConfirmDialog
        isOpen={Boolean(confirmDelete)}
        pending={deletingId !== null}
        title={t("terminalHub.deleteConfirmTitle", {
          defaultValue: "删除终端",
        })}
        message={t("terminalHub.deleteConfirmMessage", {
          defaultValue: "确定要删除终端「{{name}}」吗？",
          name: confirmDelete?.name ?? "",
        })}
        onConfirm={async () => {
          if (!confirmDelete) return;
          setDeletingId(confirmDelete.id);
          try {
            await hub.deleteTerminal(confirmDelete.id);
          } finally {
            setDeletingId(null);
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />

      <ConfirmDialog
        isOpen={Boolean(confirmDeleteProject)}
        title={t("project.deleteConfirmTitle", {
          defaultValue: "删除项目",
        })}
        message={t("project.deleteConfirmMessage", {
          defaultValue:
            "确定要删除项目「{{name}}」吗？快照（MCP / Skills / CLAUDE.md）将一并删除。",
          name: confirmDeleteProject?.name ?? "",
        })}
        confirmText={t("project.delete", { defaultValue: "删除" })}
        onConfirm={() => void handleDeleteProject()}
        onCancel={() => setConfirmDeleteProject(null)}
      />
    </>
  );
}
