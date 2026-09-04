import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileJson,
  FileCode,
  FileImage,
  FileVideo,
  FileArchive,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
} from "lucide-react";

import {
  projectFilesApi,
  type GitStatusEntry,
  type ProjectDirEntry,
} from "@/lib/api/projectFiles";
import { FileEditorDialog } from "./FileEditorDialog";
import { cn } from "@/lib/utils";

interface ProjectFileBrowserProps {
  projectDir: string;
}

/** 文件类型信息：按扩展名归类 → 展示颜色 + 是否二进制 */
interface FileTypeInfo {
  color: string;
  binary: boolean;
}

const FILE_TYPE_RULES: Array<{ match: RegExp; color: string; binary: boolean }> = [
  // 图片
  {
    match: /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif|heic)$/i,
    color: "text-purple-600 dark:text-purple-400",
    binary: true,
  },
  // 音视频
  {
    match: /\.(mp4|mov|avi|mkv|webm|mp3|wav|flac|ogg|m4a)$/i,
    color: "text-pink-600 dark:text-pink-400",
    binary: true,
  },
  // 文档 / 压缩包
  {
    match: /\.(pdf|docx?|xlsx?|pptx?|zip|tar|gz|rar|7z|jar|class)$/i,
    color: "text-orange-600 dark:text-orange-400",
    binary: true,
  },
  // 配置文件
  {
    match: /\.(json|jsonc|toml|yaml|yml|ini|conf|config|env|properties)$/i,
    color: "text-yellow-600 dark:text-yellow-400",
    binary: false,
  },
  // 文档 / 文本
  {
    match: /\.(md|markdown|txt|rst|log)$/i,
    color: "text-blue-600 dark:text-blue-400",
    binary: false,
  },
  // 代码
  {
    match:
      /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|py|go|rs|java|rb|php|sh|bat|ps1|css|scss|html|vue|svelte|sql|c|cpp|h|hpp)$/i,
    color: "text-sky-600 dark:text-sky-400",
    binary: false,
  },
];

function fileTypeInfo(name: string): FileTypeInfo {
  for (const rule of FILE_TYPE_RULES) {
    if (rule.match.test(name)) return rule;
  }
  return { color: "text-muted-foreground", binary: false };
}

/** git status raw 代码 → 展示标记；无变更记录时返回 null */
function gitBadge(
  status: GitStatusEntry | undefined,
): { text: string; cls: string } | null {
  if (!status) return null;
  const raw = status.raw.trim();
  if (!raw) return null;
  const map: Record<string, { text: string; cls: string }> = {
    M: { text: "M", cls: "text-amber-600 bg-amber-500/10 dark:text-amber-400" },
    A: { text: "A", cls: "text-emerald-600 bg-emerald-500/10 dark:text-emerald-400" },
    D: { text: "D", cls: "text-red-600 bg-red-500/10 dark:text-red-400" },
    R: { text: "R", cls: "text-blue-600 bg-blue-500/10 dark:text-blue-400" },
    "??": { text: "U", cls: "text-muted-foreground bg-muted" },
    C: { text: "C", cls: "text-blue-600 bg-blue-500/10 dark:text-blue-400" },
  };
  const code = status.raw === "??" ? "??" : raw.charAt(0);
  return map[code] ?? null;
}

function FileIcon({ name, color }: { name: string; color: string }) {
  const lower = name.toLowerCase();
  const cls = `h-3.5 w-3.5 shrink-0 ${color}`;
  if (/(\.(png|jpe?g|gif|webp|svg|ico|bmp|avif|heic))$/i.test(lower)) {
    return <FileImage className={cls} />;
  }
  if (/(\.(mp4|mov|avi|mkv|webm|mp3|wav|flac|ogg|m4a))$/i.test(lower)) {
    return <FileVideo className={cls} />;
  }
  if (/(\.(zip|tar|gz|rar|7z|jar|class|pdf|docx?|xlsx?|pptx?))$/i.test(lower)) {
    return <FileArchive className={cls} />;
  }
  if (/\.(json|jsonc|toml|yaml|yml|ini|conf|config|env|properties)$/i.test(lower)) {
    return <FileJson className={cls} />;
  }
  if (/\.(md|markdown|txt|rst|log)$/i.test(lower)) {
    return <FileText className={cls} />;
  }
  if (
    /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|py|go|rs|java|rb|php|sh|bat|ps1|css|scss|html|vue|svelte|sql|c|cpp|h|hpp)$/i.test(
      lower,
    )
  ) {
    return <FileCode className={cls} />;
  }
  return <File className={cls} />;
}

/**
 * 项目文件浏览器：懒加载目录树 + Git 变更标记 + 点击文件打开在线编辑器。
 */
export function ProjectFileBrowser({ projectDir }: ProjectFileBrowserProps) {
  const { t } = useTranslation();
  /** 已展开的目录 rel → 子条目 */
  const [dirs, setDirs] = useState<Record<string, ProjectDirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [rootLoaded, setRootLoaded] = useState(false);
  const [gitMap, setGitMap] = useState<Record<string, GitStatusEntry>>({});
  const [editorFile, setEditorFile] = useState<string | null>(null);

  // 首次进入加载根目录 + git 状态
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      setRootLoaded(false);
      setDirs({});
      setExpanded(new Set());
      setGitMap({});
      try {
        const [entries, git] = await Promise.all([
          projectFilesApi.listDir(projectDir, ""),
          projectFilesApi.gitStatus(projectDir).catch(() => ({
            git: false,
            entries: [] as GitStatusEntry[],
          })),
        ]);
        if (cancelled) return;
        setDirs({ "": entries });
        setRootLoaded(true);
        const map: Record<string, GitStatusEntry> = {};
        for (const entry of git.entries) {
          map[entry.path] = entry;
        }
        setGitMap(map);
      } catch {
        if (!cancelled) setRootLoaded(true);
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  const loadDir = useCallback(
    async (rel: string) => {
      if (dirs[rel] !== undefined || loadingDirs.has(rel)) return;
      setLoadingDirs((prev) => new Set(prev).add(rel));
      try {
        const entries = await projectFilesApi.listDir(projectDir, rel);
        setDirs((prev) => ({ ...prev, [rel]: entries }));
      } catch {
        // 目录读取失败：保持未加载状态
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(rel);
          return next;
        });
      }
    },
    [dirs, loadingDirs, projectDir],
  );

  const toggleDir = (rel: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) {
        next.delete(rel);
      } else {
        next.add(rel);
        void loadDir(rel);
      }
      return next;
    });
  };

  const renderEntry = (entry: ProjectDirEntry, depth: number) => {
    const badge = entry.isDir ? null : gitBadge(gitMap[entry.rel]);
    if (entry.isDir) {
      const open = expanded.has(entry.rel);
      const children = dirs[entry.rel];
      const loading = loadingDirs.has(entry.rel);
      return (
        <div key={entry.rel}>
          <div
            role="button"
            tabIndex={0}
            onClick={() => toggleDir(entry.rel)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleDir(entry.rel);
              }
            }}
            className="flex w-full cursor-pointer items-center gap-1 rounded px-1 py-[3px] text-left hover:bg-zinc-800/50"
            style={{ paddingLeft: `${depth * 12 + 4}px` }}
            title={entry.rel}
          >
            {loading ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-zinc-500" />
            ) : open ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-zinc-500" />
            )}
            {open ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-blue-400/80" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400/70" />
            )}
            <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-300">
              {entry.name}
            </span>
          </div>
          {open && children !== undefined && (
            <div>
              {children.map((child) => renderEntry(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    const typeInfo = fileTypeInfo(entry.name);
    const openFile = () => {
      if (typeInfo.binary) {
        toast.info(
          t("projectFile.binaryFile", {
            file: entry.name,
            defaultValue: "「{{file}}」是二进制文件，无法在编辑器中打开",
          }),
        );
        return;
      }
      setEditorFile(entry.rel);
    };

    return (
      <div
        key={entry.rel}
        role="button"
        tabIndex={0}
        onClick={openFile}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openFile();
          }
        }}
        className="group flex w-full cursor-pointer items-center gap-1 rounded px-1 py-[3px] text-left hover:bg-zinc-800/50"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        title={t("projectFile.openEditor", {
          file: entry.name,
          defaultValue: `打开 ${entry.name}`,
        })}
      >
        <span className="w-3 shrink-0" />
        <FileIcon name={entry.name} color={typeInfo.color} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[11px] group-hover:text-zinc-100",
            typeInfo.color,
          )}
        >
          {entry.name}
        </span>
        {badge && (
          <span
            className={cn(
              "shrink-0 rounded px-1 text-[9px] font-bold",
              badge.cls,
            )}
          >
            {badge.text}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {!rootLoaded ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
          </div>
        ) : (dirs[""] ?? []).length === 0 ? (
          <p className="px-2 py-4 text-center text-[10px] text-zinc-500">
            {t("projectFile.empty", {
              defaultValue: "目录为空",
            })}
          </p>
        ) : (
          (dirs[""] ?? []).map((entry) => renderEntry(entry, 0))
        )}
      </div>

      <FileEditorDialog
        open={Boolean(editorFile)}
        filePath={
          editorFile
            ? `${projectDir.replace(/[\\/]+$/, "")}/${editorFile}`
            : ""
        }
        projectDir={projectDir}
        onClose={() => setEditorFile(null)}
      />
    </div>
  );
}