import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, FolderKanban } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { projectApi } from "@/lib/api/project";
import { cn } from "@/lib/utils";

export interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectDirs: string[];
  defaultProjectDir?: string;
  onBrowse: () => Promise<string | null>;
  onCreated: () => void;
}

export function NewProjectDialog({
  open,
  onOpenChange,
  projectDirs,
  defaultProjectDir,
  onBrowse,
  onCreated,
}: NewProjectDialogProps) {
  const { t } = useTranslation();

  const [name, setName] = useState("");
  const [projectDir, setProjectDir] = useState(defaultProjectDir ?? "");
  const [browsing, setBrowsing] = useState(false);
  const [pending, setPending] = useState(false);

  // 打开时重置
  useEffect(() => {
    if (!open) return;
    setName("");
    setProjectDir(defaultProjectDir ?? "");
  }, [open, defaultProjectDir]);

  const dirOptions = useMemo(() => {
    const list = projectDirs.filter(Boolean);
    const current = projectDir.trim();
    if (current && !list.includes(current)) return [current, ...list];
    return list;
  }, [projectDirs, projectDir]);

  const canSubmit = name.trim().length > 0 && projectDir.trim().length > 0;

  const handleBrowse = async () => {
    setBrowsing(true);
    try {
      const dir = await onBrowse();
      if (dir) setProjectDir(dir);
    } finally {
      setBrowsing(false);
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit || pending) return;
    setPending(true);
    try {
      // 不手动选择工具：后端会自动记录当前各 app 选中的供应商
      await projectApi.create({
        name: name.trim(),
        projectDir: projectDir.trim(),
        tools: {},
      });
      onCreated();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onOpenChange(false);
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col overflow-hidden rounded-2xl">
        <DialogHeader className="shrink-0 border-b border-border/60 pb-4">
          <DialogTitle>
            {t("project.newDialog.title", { defaultValue: "新建项目" })}
          </DialogTitle>
          <DialogDescription>
            {t("project.newDialog.description", {
              defaultValue:
                "把 Claude Code 当前的供应商、MCP、Skills、记忆文件保存为一个项目，之后可一键切换。",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto py-3 pr-1">
          <div className="space-y-2">
            <Label htmlFor="project-name">
              {t("project.newDialog.name", { defaultValue: "项目名称" })}
            </Label>
            <Input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("project.newDialog.namePlaceholder", {
                defaultValue: "例如：商城项目",
              })}
            />
          </div>

          <div className="space-y-2">
            <Label>
              {t("project.newDialog.projectDir", {
                defaultValue: "项目目录",
              })}
            </Label>
            <div className="flex gap-2">
              <Select value={projectDir} onValueChange={setProjectDir}>
                <SelectTrigger className="min-w-0 flex-1">
                  <SelectValue
                    placeholder={t("project.newDialog.selectDir", {
                      defaultValue: "选择项目目录",
                    })}
                  />
                </SelectTrigger>
                <SelectContent>
                  {dirOptions.length === 0 ? (
                    <SelectItem value="__empty__" disabled>
                      {t("project.newDialog.noDir", {
                        defaultValue: "暂无历史目录，请点击浏览…",
                      })}
                    </SelectItem>
                  ) : (
                    dirOptions.map((dir) => (
                      <SelectItem key={dir} value={dir} className="font-mono">
                        {dir}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleBrowse()}
                disabled={browsing}
                className="shrink-0"
              >
                <FolderOpen className="mr-1.5 h-4 w-4" />
                {t("terminalHub.browse", { defaultValue: "浏览…" })}
              </Button>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/20 p-3">
            <FolderKanban
              className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground")}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("project.newDialog.captureHint", {
                defaultValue:
                  "创建时会自动记录当前各工具（Claude Code / Codex / OpenCode 等）选中的供应商，并快照保存 Claude Code 的 MCP、Skills 与 CLAUDE.md 记忆文件；切换项目时一键恢复。",
              })}
            </p>
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t border-border/60 pt-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || pending}
          >
            {t("project.newDialog.create", { defaultValue: "创建项目" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}