import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { terminalApi } from "@/lib/api/terminal";
import type { TerminalInstance } from "@/types/terminal";
import { useDarkMode } from "@/hooks/useDarkMode";
import { TerminalPrompt } from "./TerminalPrompt";

/** 深色终端配色（默认） */
const DARK_TERMINAL_THEME = {
  background: "#0b0f14",
  foreground: "#d4d4d8",
  cursor: "#34d399",
  selectionBackground: "#1e293b",
  black: "#000000",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#fca5a5",
  brightGreen: "#6ee7b7",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

/** 浅色终端配色（跟随应用浅色主题） */
const LIGHT_TERMINAL_THEME = {
  background: "#ffffff",
  foreground: "#3f3f46",
  cursor: "#059669",
  cursorAccent: "#ffffff",
  selectionBackground: "#bfdbfe",
  black: "#000000",
  red: "#dc2626",
  green: "#059669",
  yellow: "#b45309",
  blue: "#2563eb",
  magenta: "#7c3aed",
  cyan: "#0891b2",
  white: "#52525b",
  brightBlack: "#71717a",
  brightRed: "#ef4444",
  brightGreen: "#10b981",
  brightYellow: "#d97706",
  brightBlue: "#3b82f6",
  brightMagenta: "#8b5cf6",
  brightCyan: "#06b6d4",
  brightWhite: "#18181b",
};

export interface EmbeddedTerminalProps {
  /** 要启动的终端实例（切换实例时自动重启会话） */
  instance: TerminalInstance;
  /** 递增触发重启（重置/恢复会话用） */
  resetNonce?: number;
  /** 会话 pty 状态变化回调（供外部停止按钮使用） */
  onPtyChange?: (ptyId: number | null) => void;
  /** 进程退出状态变化回调 */
  onExitChange?: (exited: boolean) => void;
}

/**
 * 面板内嵌终端：会话由 Rust 后端持有（PTY），本组件只是连接/显示层。
 * - 卸载/断开连接不会终止进程，重新挂载时复用会话并回放输出历史；
 * - 「停止 / 重置」由外部通过 closeEmbedded 显式终止，这里相应显示已退出。
 */
export function EmbeddedTerminal({
  instance,
  resetNonce = 0,
  onPtyChange,
  onExitChange,
}: EmbeddedTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  const bootGenRef = useRef(0);
  const instanceRef = useRef(instance);
  instanceRef.current = instance;

  const isDark = useDarkMode();
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;

  const [bootNonce, setBootNonce] = useState(0);
  const [exited, setExited] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  // 应用主题切换时，动态更新 xterm 配色（无需重启会话）
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = isDark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
    try {
      term.refresh(0, term.rows - 1);
    } catch {
      // 终端尚未渲染完成，忽略
    }
  }, [isDark]);

  const reportPty = useCallback(
    (ptyId: number | null) => {
      ptyIdRef.current = ptyId;
      onPtyChange?.(ptyId);
    },
    [onPtyChange],
  );

  const reportExit = useCallback(
    (value: boolean) => {
      setExited(value);
      onExitChange?.(value);
    },
    [onExitChange],
  );

  /** 自适应终端尺寸并同步 PTY（校验 dims，避免未布局时算出非法行列）。 */
  const doFit = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      const dims = fit.proposeDimensions();
      const ptyId = ptyIdRef.current;
      if (dims && dims.cols > 0 && dims.rows > 0 && ptyId !== null) {
        void terminalApi.resizeEmbedded(ptyId, dims.cols, dims.rows);
      }
    } catch {
      // 容器尚未布局完成，忽略
    }
  }, []);

  const boot = useCallback(async () => {
    const current = instanceRef.current;
    const container = containerRef.current;
    if (!container) return;

    // 代数递增：使之前未完成的异步 boot 失效（防快速切换实例时误注册）
    const gen = ++bootGenRef.current;

    // 清理上一个 boot 遗留的 xterm（StrictMode 双挂载等场景，避免实例叠加）
    if (termRef.current) {
      try {
        termRef.current.dispose();
      } catch {
        // 忽略
      }
      termRef.current = null;
      fitRef.current = null;
    }

    const term = new Terminal({
      fontSize: 12,
      fontFamily:
        'ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: isDarkRef.current ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    term.open(container);
    doFit();

    const disposables: Array<() => void> = [];
    const onDataDisposable = term.onData((data) => {
      const ptyId = ptyIdRef.current;
      if (ptyId !== null) {
        void terminalApi.writeEmbedded(ptyId, data);
      }
    });
    disposables.push(() => onDataDisposable.dispose());

    setBootError(null);
    reportExit(false);
    try {
      // 幂等：复用已有会话（后端保持运行），仅当会话不存在/已退出时新建
      const ptyId = await terminalApi.ensureEmbedded({
        instanceId: current.id,
        app: current.app,
        projectDir: current.projectDir,
        tool: current.tool,
        customCommand: current.customCommand ?? null,
        args: current.args ?? null,
        terminal: current.terminal ?? null,
        providerId: null,
      });
      // 启动期间实例已被切换：本次连接作废（会话本身保留在后台）
      if (gen !== bootGenRef.current) {
        try {
          term.dispose();
        } catch {
          // 忽略
        }
        return;
      }
      reportPty(ptyId);
      await terminalApi.attachEmbedded(ptyId, (evt) => {
        if (evt.kind === "data") {
          term.write(new Uint8Array(evt.data));
        } else {
          reportExit(true);
        }
      });
      // 历史回放完成后滚到最新内容（xterm 通常自动滚动，这里兜底）
      try {
        term.scrollToBottom();
      } catch {
        // 忽略
      }
      // 尺寸变化 → 自适应并同步 PTY
      const resizeObserver = new ResizeObserver(() => doFit());
      resizeObserver.observe(container);
      disposables.push(() => resizeObserver.disconnect());
      // 布局/字体就绪后再自适应几次（首次 fit 常因字体未加载而偏小）
      const fitTimers = [
        window.setTimeout(doFit, 50),
        window.setTimeout(doFit, 300),
      ];
      if (document.fonts?.ready) {
        document.fonts.ready.then(doFit).catch(() => undefined);
      }
      disposables.push(() => {
        fitTimers.forEach((timer) => window.clearTimeout(timer));
      });
    } catch (error) {
      console.error("[EmbeddedTerminal] failed to connect pty", error);
      setBootError(String(error));
      reportExit(true);
    }

    return () => {
      disposables.forEach((fn) => fn());
    };
  }, [reportExit, reportPty]);

  // 实例切换 / 外部触发（重置、恢复会话）→ 重新连接（复用或新建会话）
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void boot().then((fn) => {
      if (cancelled) {
        fn?.();
      } else {
        cleanup = fn;
      }
    });
    return () => {
      cancelled = true;
      bootGenRef.current += 1;
      cleanup?.();
      // 清理本实例的 xterm DOM；会话保留在后台继续运行（重连即可恢复）
      if (termRef.current) {
        try {
          termRef.current.dispose();
        } catch {
          // 忽略
        }
        termRef.current = null;
        fitRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id, resetNonce, bootNonce]);

  /** 显式重启：终止当前会话并启动全新会话（后端 kill 旧进程）。 */
  const restart = useCallback(async () => {
    const oldPty = ptyIdRef.current;
    if (oldPty !== null) {
      try {
        await terminalApi.closeEmbedded(oldPty);
      } catch {
        // 忽略
      }
      reportPty(null);
    }
    setBootNonce((n) => n + 1);
  }, [reportPty]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* xterm 容器绝对定位铺满：避免 flex 布局干扰 xterm 的绝对定位 viewport */}
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
      </div>
      <TerminalPrompt getPtyId={() => ptyIdRef.current} />
      {(exited || bootError) && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-t border-border py-2 text-[11px] text-muted-foreground">
          <span>
            {bootError
              ? `内嵌终端启动失败：${bootError}`
              : "终端进程已退出，输出保留在下方"}
          </span>
          <button
            type="button"
            onClick={restart}
            className="rounded border border-border px-2 py-0.5 text-muted-foreground transition-colors hover:bg-muted"
          >
            重新启动
          </button>
        </div>
      )}
    </div>
  );
}
