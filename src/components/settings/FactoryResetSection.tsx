import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { TriangleAlert } from "lucide-react";
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
import { settingsApi } from "@/lib/api";
import { extractErrorMessage } from "@/utils/errorUtils";

/** 确认输入必须命中的关键词（大小写不敏感，兼容中英文） */
const CONFIRM_WORDS = ["reset", "重置"];

/**
 * 恢复出厂（重置所有配置）：
 * - 停止代理并还原所有被接管的 Live 配置；
 * - 自动备份数据库到 backups 目录（之后可从"备份与恢复"找回）；
 * - 清空供应商 / 项目方案 / 提示词 / MCP / 代理配置 / 用量记录，重置应用设置；
 * - 完成后应用自动重启。
 */
export function FactoryResetSection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const confirmed = CONFIRM_WORDS.includes(confirmText.trim().toLowerCase());

  const handleReset = async () => {
    setSubmitting(true);
    try {
      await settingsApi.factoryReset();
      toast.success(
        t("settings.factoryReset.started", {
          defaultValue: "正在重置所有配置，应用即将自动重启…",
        }),
        { duration: 10_000 },
      );
      setOpen(false);
    } catch (error) {
      toast.error(
        t("settings.factoryReset.failed", {
          defaultValue: "恢复出厂失败：{{error}}",
          error: extractErrorMessage(error),
        }),
        { duration: 8000 },
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
          <div className="min-w-0 flex-1 space-y-2">
            <h4 className="text-sm font-semibold text-red-600 dark:text-red-400">
              {t("settings.factoryReset.title", {
                defaultValue: "重置所有配置（恢复出厂）",
              })}
            </h4>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("settings.factoryReset.description", {
                defaultValue:
                  "将停止本地路由并还原 Claude / Codex 等客户端配置，清空全部供应商、项目方案、提示词、MCP、代理配置与用量记录，并重置应用设置。重置前会自动备份数据库到 backups 目录，可随时从「备份与恢复」找回。完成后应用会自动重启。",
              })}
            </p>
            <Button
              variant="destructive"
              size="sm"
              disabled={submitting}
              onClick={() => {
                setConfirmText("");
                setOpen(true);
              }}
            >
              {t("settings.factoryReset.action", {
                defaultValue: "重置所有配置",
              })}
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={open} onOpenChange={(next) => !submitting && setOpen(next)}>
        <DialogContent className="max-w-md" zIndex="alert">
          <DialogHeader>
            <DialogTitle>
              {t("settings.factoryReset.confirmTitle", {
                defaultValue: "确认恢复出厂？",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("settings.factoryReset.confirmMessage", {
                defaultValue:
                  "此操作会清空全部配置且不可在本界面内撤销（数据已自动备份到 backups 目录）。如确认继续，请在下方输入 RESET。",
              })}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            placeholder={t("settings.factoryReset.confirmPlaceholder", {
              defaultValue: "输入 RESET 以确认",
            })}
            disabled={submitting}
          />
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={() => setOpen(false)}
            >
              {t("common.cancel", { defaultValue: "取消" })}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!confirmed || submitting}
              onClick={handleReset}
            >
              {submitting
                ? t("settings.factoryReset.resetting", {
                    defaultValue: "重置中…",
                  })
                : t("settings.factoryReset.action", {
                    defaultValue: "重置所有配置",
                  })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
