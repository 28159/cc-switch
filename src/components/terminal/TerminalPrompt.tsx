import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bold,
  Italic,
  Code2,
  List,
  Heading1,
  Quote,
  Wand2,
  SendHorizonal,
  History,
  Trash2,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";

import { terminalApi } from "@/lib/api/terminal";

const HISTORY_KEY = "cc-switch-terminal-prompt-history";
const HISTORY_LIMIT = 50;

interface PromptHistoryEntry {
  text: string;
  at: number;
}

function loadHistory(): PromptHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is PromptHistoryEntry =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as PromptHistoryEntry).text === "string",
      )
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveHistory(entries: PromptHistoryEntry[]) {
  try {
    window.localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(entries.slice(0, HISTORY_LIMIT)),
    );
  } catch {
    // 忽略存储失败
  }
}

export interface TerminalPromptProps {
  /** 获取当前内嵌会话 pty id（无会话时为 null） */
  getPtyId: () => number | null;
}

/** 插入 markdown 标记到选区。 */
function wrapSelection(
  textarea: HTMLTextAreaElement,
  prefix: string,
  suffix = prefix,
) {
  const { selectionStart, selectionEnd, value } = textarea;
  const selected = value.slice(selectionStart, selectionEnd) || "文本";
  const next =
    value.slice(0, selectionStart) +
    prefix +
    selected +
    suffix +
    value.slice(selectionEnd);
  textarea.value = next;
  textarea.focus();
  textarea.selectionStart = selectionStart + prefix.length;
  textarea.selectionEnd = selectionStart + prefix.length + selected.length;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * 终端底部输入面板：富文本（markdown 快捷插入）+ AI 润色 + 发送到内嵌终端，
 * 发送记录保存在本地（可清空、可还原回填）。
 */
export function TerminalPrompt({ getPtyId }: TerminalPromptProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [polishing, setPolishing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<PromptHistoryEntry[]>(() =>
    loadHistory(),
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const persistEntry = useCallback((entry: PromptHistoryEntry) => {
    setHistory((prev) => {
      const next = [
        entry,
        ...prev.filter((item) => item.text !== entry.text),
      ].slice(0, HISTORY_LIMIT);
      saveHistory(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveHistory([]);
    toast.success("发送记录已清空");
  }, []);

  const handleSend = useCallback(() => {
    const content = text.trim();
    if (!content) return;
    const ptyId = getPtyId();
    if (ptyId === null) {
      toast.error("当前终端会话不可用，请先启动终端");
      return;
    }
    // 先写内容，延迟后再补回车（避免整段被当粘贴文本，回车变成换行）
    void (async () => {
      try {
        await terminalApi.writeEmbedded(ptyId, content);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await terminalApi.writeEmbedded(ptyId, "\r");
      } catch (error) {
        toast.error(`发送失败：${String(error)}`);
        return;
      }
      persistEntry({ text: content, at: Date.now() });
      setText("");
    })();
  }, [getPtyId, persistEntry, text]);

  const handlePolish = useCallback(async () => {
    const content = text.trim();
    if (!content) {
      toast.error("请先输入需要润色的内容");
      return;
    }
    setPolishing(true);
    try {
      const polished = await terminalApi.polishPrompt("claude", content);
      setText(polished);
      toast.success("润色完成");
    } catch (error) {
      toast.error(`润色失败：${String(error)}`);
    } finally {
      setPolishing(false);
    }
  }, [text]);

  const insertMark = useCallback((prefix: string, suffix = prefix) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    wrapSelection(textarea, prefix, suffix);
    setText(textarea.value);
  }, []);

  useEffect(() => {
    if (!open) setHistoryOpen(false);
  }, [open]);

  if (!open) {
    return (
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="展开输入面板（富文本 / AI 润色）"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              handleSend();
            }
          }}
          placeholder="输入要发送到终端的内容"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:border-foreground/40 focus:outline-none"
        />
        <button
          type="button"
          onClick={handleSend}
          title="发送到终端（Enter）"
          className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-emerald-600/90 px-2.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          disabled={!text.trim()}
        >
          <SendHorizonal className="h-3 w-3" />
          发送
        </button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-col border-t border-border bg-background/60">
      {/* 工具栏 */}
      <div className="flex items-center gap-0.5 px-2 pt-1.5">
        {[
          { icon: Bold, title: "加粗", mark: "**" },
          { icon: Italic, title: "斜体", mark: "*" },
          { icon: Code2, title: "行内代码", mark: "`" },
          { icon: List, title: "列表", mark: "- ", suffix: "" },
          { icon: Heading1, title: "标题", mark: "# ", suffix: "" },
          { icon: Quote, title: "引用", mark: "> ", suffix: "" },
        ].map(({ icon: Icon, title, mark, suffix }) => (
          <button
            key={title}
            type="button"
            title={title}
            onClick={() => insertMark(mark, suffix ?? mark)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
        <div className="mx-1 h-4 w-px bg-border" />
        <button
          type="button"
          onClick={() => void handlePolish()}
          disabled={polishing}
          title="AI 润色（经本地代理调用当前供应商）"
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-violet-600 transition-colors hover:bg-muted disabled:opacity-50 dark:text-violet-300"
        >
          {polishing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Wand2 className="h-3.5 w-3.5" />
          )}
          AI 润色
        </button>
        <div className="flex-1" />
        <div className="relative">
          <button
            type="button"
            onClick={() => setHistoryOpen((prev) => !prev)}
            title="发送记录"
            className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <History className="h-3.5 w-3.5" />
            记录 {history.length > 0 ? `(${history.length})` : ""}
            <ChevronDown className="h-3 w-3" />
          </button>
          {historyOpen && (
            <div className="absolute bottom-full right-0 z-20 mb-1 w-80 overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
              <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
                <span className="text-[10px] text-muted-foreground">
                  发送记录（点击还原）
                </span>
                <button
                  type="button"
                  onClick={clearHistory}
                  title="清空记录"
                  className="flex h-5 items-center gap-0.5 rounded px-1 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-red-500"
                >
                  <Trash2 className="h-3 w-3" />
                  清空
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {history.length === 0 ? (
                  <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                    暂无发送记录
                  </p>
                ) : (
                  history.map((entry, index) => (
                    <button
                      key={`${entry.at}-${index}`}
                      type="button"
                      onClick={() => {
                        setText(entry.text);
                        setHistoryOpen(false);
                        textareaRef.current?.focus();
                      }}
                      className="block w-full truncate px-2 py-1.5 text-left text-[11px] text-foreground transition-colors hover:bg-muted"
                      title="点击还原到输入框"
                    >
                      {entry.text}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="ml-1 flex h-6 items-center rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          收起
        </button>
      </div>

      {/* 输入区 */}
      <div className="flex items-end gap-2 px-2 py-1.5">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              handleSend();
            }
          }}
          placeholder="输入要发送到终端的内容"
          rows={3}
          className="min-h-0 flex-1 resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-foreground/40 focus:outline-none"
        />
        <button
          type="button"
          onClick={handleSend}
          title="发送到终端（Ctrl/⌘ + Enter）"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-emerald-600/90 px-3 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          disabled={!text.trim()}
        >
          <SendHorizonal className="h-3.5 w-3.5" />
          发送
        </button>
      </div>
    </div>
  );
}
