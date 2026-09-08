import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Diff,
  FileCode2,
  Loader2,
  Save,
  X,
} from "lucide-react";
import { EditorView, basicSetup } from "codemirror";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorState } from "@codemirror/state";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { projectFilesApi } from "@/lib/api/projectFiles";
import { useDarkMode } from "@/hooks/useDarkMode";
import { cn } from "@/lib/utils";

interface FileEditorDialogProps {
  open: boolean;
  filePath: string;
  projectDir: string;
  onClose: () => void;
  /** 初始视图：编辑 或 差异（从 Git 更改点击进入时传 "diff"） */
  initialView?: "edit" | "diff";
}

/** 按扩展名选择 CodeMirror 语言扩展 */
function languageFor(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return json();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return markdown();
  if (
    /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(lower)
  ) {
    return javascript({
      typescript: /\.tsx?$/.test(lower),
      jsx: /\.jsx$/.test(lower),
    });
  }
  return [];
}

/** 编辑器等宽字体（深浅主题共用） */
const EDITOR_FONT_FAMILY =
  "Consolas, 'Cascadia Mono', 'Courier New', 'JetBrains Mono', monospace";

/** 深色主题（终端同款配色） */
const darkTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "#0b0e14",
      fontSize: "13px",
    },
    ".cm-content": {
      color: "#e6edf3",
      caretColor: "#e6edf3",
      fontFamily: EDITOR_FONT_FAMILY,
    },
    ".cm-gutters": {
      backgroundColor: "#0d1117",
      color: "#3a4256",
      borderRight: "1px solid #1c2230",
    },
    ".cm-activeLine": { backgroundColor: "#12161f" },
    ".cm-activeLineGutter": { backgroundColor: "#12161f" },
    ".cm-selectionBackground": { backgroundColor: "#264f78 !important" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "#264f78" },
    ".cm-cursor": { borderLeftColor: "#3b82f6" },
  },
  { dark: true },
);

/** 浅色主题（跟随应用浅色主题） */
const lightTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "#ffffff",
      fontSize: "13px",
    },
    ".cm-content": {
      color: "#1f2328",
      caretColor: "#1f2328",
      fontFamily: EDITOR_FONT_FAMILY,
    },
    ".cm-gutters": {
      backgroundColor: "#f6f8fa",
      color: "#57606a",
      borderRight: "1px solid #d0d7de",
    },
    ".cm-activeLine": { backgroundColor: "#f6f8fa" },
    ".cm-activeLineGutter": { backgroundColor: "#f6f8fa" },
    ".cm-selectionBackground": { backgroundColor: "#b6d7ff !important" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "#b6d7ff" },
    ".cm-cursor": { borderLeftColor: "#0969da" },
  },
  { dark: false },
);

/** 统一 diff 文本的简单着色 */
function DiffView({ diff, untracked, content }: { diff: string; untracked?: boolean; content?: string }) {
  const text = untracked ? content ?? "" : diff;
  return (
    <pre className="h-full flex-1 overflow-auto bg-background p-3 font-mono text-[11px] leading-relaxed">
      {untracked && (
        <span className="block text-[10px] text-amber-600/80 dark:text-amber-400/80">
          [未跟踪文件，无基线可比，显示当前内容]
        </span>
      )}
      {text.split("\n").map((line, index) => {
        let cls = "text-muted-foreground";
        if (line.startsWith("+") && !line.startsWith("+++")) {
          cls = "text-emerald-600 bg-emerald-500/10 dark:text-emerald-400";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          cls = "text-red-600 bg-red-500/10 dark:text-red-400";
        } else if (line.startsWith("@@")) {
          cls = "text-blue-600 bg-blue-500/10 dark:text-blue-400";
        } else if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
          cls = "text-muted-foreground/70";
        }
        return (
          <div key={index} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export function FileEditorDialog({
  open,
  filePath,
  projectDir,
  onClose,
  initialView = "edit",
}: FileEditorDialogProps) {
  const { t } = useTranslation();
  const isDark = useDarkMode();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [viewMode, setViewMode] = useState<"edit" | "diff">(initialView);
  const [diffResult, setDiffResult] = useState<{
    diff: string;
    untracked?: boolean;
    content?: string;
  } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const fileName = useMemo(() => {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] ?? filePath;
  }, [filePath]);

  // 加载文件内容
  useEffect(() => {
    if (!open || !filePath) return;
    setLoading(true);
    setViewMode(initialView);
    setDiffResult(null);
    projectFilesApi
      .readFile(filePath)
      .then(setContent)
      .catch((error) => {
        toast.error(String(error ?? ""));
      })
      .finally(() => setLoading(false));
  }, [open, filePath, initialView]);

  // 差异视图下自动加载 diff（初始即 diff / 点「差异」按钮进入 / 从编辑切回）
  useEffect(() => {
    if (!open || !filePath || viewMode !== "diff" || diffResult !== null || diffLoading) return;
    void loadDiff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filePath, viewMode, diffResult, diffLoading]);

  const loadDiff = useCallback(async () => {
    setDiffLoading(true);
    try {
      const result = await projectFilesApi.gitDiff(projectDir, filePath);
      if (!result.git) {
        toast.info(
          t("projectFile.notGitRepo", {
            defaultValue: "该目录不是 Git 仓库",
          }),
        );
        // 非 git 仓库无法对比，退回编辑视图（避免自动加载死循环）
        setViewMode("edit");
        return;
      }
      setDiffResult({
        diff: result.diff,
        untracked: result.untracked,
        content: result.content,
      });
    } catch (error) {
      toast.error(String(error ?? ""));
      setViewMode("edit");
    } finally {
      setDiffLoading(false);
    }
  }, [projectDir, filePath, t]);

  // 创建 CodeMirror 编辑器（打开后初始化，内容变化同步回 state；主题切换时重建）
  useEffect(() => {
    if (!open || loading || !containerRef.current) return;
    const extensions = [
      basicSetup,
      languageFor(fileName),
      ...(isDark ? [oneDark, darkTheme] : [lightTheme]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) setContent(update.state.doc.toString());
      }),
    ];
    const state = EditorState.create({ doc: content, extensions });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loading, fileName, isDark]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await projectFilesApi.writeFile(filePath, content);
      toast.success(
        t("projectFile.saved", { defaultValue: "文件已保存" }),
      );
    } catch (error) {
      toast.error(String(error ?? ""));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] w-[min(860px,94vw)] flex-col gap-0 overflow-hidden border-border bg-background p-0 text-foreground"
      >
        <DialogHeader className="flex shrink-0 flex-row items-center gap-2 border-b border-border bg-muted/50 px-3 py-2">
          <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {fileName}
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 gap-1.5 text-xs",
                viewMode === "diff"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              onClick={() => setViewMode("diff")}
              disabled={diffLoading}
              title={t("projectFile.showDiff", {
                defaultValue: "查看 Git 差异",
              })}
            >
              {diffLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Diff className="h-3.5 w-3.5" />
              )}
              {t("projectFile.diff", { defaultValue: "差异" })}
            </Button>
            {viewMode === "diff" && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setViewMode("edit")}
              >
                {t("projectFile.edit", { defaultValue: "编辑" })}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onClose}
              title={t("common.close", { defaultValue: "关闭" })}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="min-h-[45vh] flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : viewMode === "diff" ? (
            <DiffView
              diff={diffResult?.diff ?? ""}
              untracked={diffResult?.untracked}
              content={diffResult?.content}
            />
          ) : (
            <div ref={containerRef} className="h-full w-full" />
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border bg-muted/30 px-3 py-2 sm:justify-between">
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {filePath}
          </span>
          {viewMode === "edit" ? (
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => void handleSave()}
              disabled={saving || loading}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {saving
                ? t("common.saving", { defaultValue: "保存中…" })
                : t("common.save", { defaultValue: "保存" })}
            </Button>
          ) : (
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => setViewMode("edit")}
            >
              <FileCode2 className="h-3.5 w-3.5" />
              {t("projectFile.backToEdit", {
                defaultValue: "返回编辑",
              })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}