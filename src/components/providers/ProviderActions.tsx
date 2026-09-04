import {
  Activity,
  BarChart3,
  Check,
  Copy,
  Edit,
  Loader2,
  Minus,
  Play,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { AppId } from "@/lib/api";
import { isAdditiveAppId } from "@/config/appConfig";

interface OpenClawDefaultModelOption {
  id: string;
  name?: string;
}

interface ProviderActionsProps {
  appId?: AppId;
  isCurrent: boolean;
  isInConfig?: boolean;
  isTesting?: boolean;
  isProxyTakeover?: boolean;
  isOmo?: boolean;
  onSwitch: () => void;
  onEdit: () => void;
  onDuplicate?: () => void;
  onTest?: () => void;
  onConfigureUsage?: () => void;
  /** 刷新用量统计（卡片内联用量已精简，刷新入口收进菜单） */
  onRefreshUsage?: () => void;
  onDelete: () => void;
  onRemoveFromConfig?: () => void;
  onDisableOmo?: () => void;
  onOpenTerminal?: () => void;
  isAutoFailoverEnabled?: boolean;
  isInFailoverQueue?: boolean;
  onToggleFailover?: (enabled: boolean) => void;
  isOfficialBlockedByProxy?: boolean;
  // Hermes v12+ providers: dict overlay — edit/delete must go through Web UI
  isReadOnly?: boolean;
  // OpenClaw: default model
  isDefaultModel?: boolean;
  isRemovalProtected?: boolean;
  isStateChangeProtected?: boolean;
  defaultModelOptions?: OpenClawDefaultModelOption[];
  onSetAsDefault?: (modelId?: string) => void;
}

interface MenuItemState {
  disabled: boolean;
  variant: "default" | "secondary";
  className: string;
  icon: JSX.Element;
  text: string;
  title?: string;
}

export function ProviderActions({
  appId,
  isCurrent,
  isInConfig = false,
  isTesting,
  isOmo = false,
  onSwitch,
  onEdit,
  onDuplicate,
  onTest,
  onConfigureUsage,
  onRefreshUsage,
  onDelete,
  onRemoveFromConfig,
  onDisableOmo,
  onOpenTerminal,
  isAutoFailoverEnabled = false,
  isInFailoverQueue = false,
  onToggleFailover,
  isOfficialBlockedByProxy = false,
  isReadOnly = false,
  isDefaultModel = false,
  isRemovalProtected = false,
  isStateChangeProtected = false,
  defaultModelOptions = [],
  onSetAsDefault,
}: ProviderActionsProps) {
  const { t } = useTranslation();

  // Additive provider membership: providers can coexist in the native config.
  const isAdditiveMode =
    Boolean(appId && isAdditiveAppId(appId)) &&
    !(appId === "opencode" && isOmo);

  // 故障转移模式下的按钮逻辑（累加模式和 OMO 应用不支持故障转移）
  const isFailoverMode =
    !isAdditiveMode && !isOmo && isAutoFailoverEnabled && onToggleFailover;
  const isMembershipMode = isAdditiveMode;
  const piStateChangeHint = t("pi.current.stateUnavailableHint");

  const handleMainAction = () => {
    if (isOmo) {
      if (isCurrent) {
        onDisableOmo?.();
      } else {
        onSwitch();
      }
    } else if (isMembershipMode) {
      // 累加模式：切换配置状态（添加/移除）
      if (isInConfig) {
        if (onRemoveFromConfig) {
          onRemoveFromConfig();
        } else {
          onDelete();
        }
      } else {
        onSwitch(); // 添加到配置
      }
    } else if (isFailoverMode) {
      onToggleFailover(!isInFailoverQueue);
    } else {
      onSwitch();
    }
  };

  const getMainItemState = (): MenuItemState => {
    if (isOmo) {
      if (isCurrent) {
        return {
          disabled: false,
          variant: "secondary" as const,
          className: "",
          icon: <Check className="h-3.5 w-3.5" />,
          text: t("provider.inUse"),
        };
      }
      return {
        disabled: false,
        variant: "default" as const,
        className: "",
        icon: <Play className="h-3.5 w-3.5" />,
        text: t("provider.enable"),
      };
    }

    // 累加模式（OpenCode 非 OMO / OpenClaw）
    if (isMembershipMode) {
      if (isStateChangeProtected) {
        return {
          disabled: true,
          variant: "secondary" as const,
          className: "",
          icon: isInConfig ? (
            <Minus className="h-3.5 w-3.5" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          ),
          text: isInConfig
            ? t("provider.removeFromConfig", { defaultValue: "移除" })
            : t("provider.enable", { defaultValue: "启用" }),
          title: piStateChangeHint,
        };
      }
      if (isInConfig) {
        return {
          disabled: isRemovalProtected,
          variant: "secondary" as const,
          className: "",
          icon: <Minus className="h-3.5 w-3.5" />,
          text: t("provider.removeFromConfig", { defaultValue: "移除" }),
          title: isRemovalProtected
            ? t("provider.removalProtectedHint", {
                defaultValue: "当前默认模型，不能移除",
              })
            : undefined,
        };
      }
      return {
        disabled: false,
        variant: "default" as const,
        className: "",
        icon: <Plus className="h-3.5 w-3.5" />,
        text:
          appId === "pi"
            ? t("provider.enable", { defaultValue: "启用" })
            : t("provider.addToConfig", { defaultValue: "添加" }),
      };
    }

    if (isFailoverMode) {
      if (isInFailoverQueue) {
        return {
          disabled: false,
          variant: "secondary" as const,
          className: "",
          icon: <Check className="h-3.5 w-3.5" />,
          text: t("failover.inQueue", { defaultValue: "已加入" }),
        };
      }
      return {
        disabled: false,
        variant: "default" as const,
        className: "",
        icon: <Plus className="h-3.5 w-3.5" />,
        text: t("failover.addQueue", { defaultValue: "加入" }),
      };
    }

    if (isCurrent) {
      return {
        disabled: true,
        variant: "secondary" as const,
        className: "",
        icon: <Check className="h-3.5 w-3.5" />,
        text: t("provider.inUse"),
      };
    }

    if (isOfficialBlockedByProxy) {
      return {
        disabled: true,
        variant: "default" as const,
        className: "",
        icon: <Play className="h-3.5 w-3.5" />,
        text: t("provider.enable"),
        title: t("provider.blockedByProxyHint"),
      };
    }

    return {
      disabled: false,
      variant: "default" as const,
      className: "",
      icon: <Play className="h-3.5 w-3.5" />,
      text: t("provider.enable"),
    };
  };

  const mainState = getMainItemState();
  const canDelete =
    !isReadOnly &&
    (appId === "pi"
      ? !isStateChangeProtected
      : isOmo || isAdditiveMode
        ? true
        : !isCurrent);
  const readOnlyHint = t("provider.managedByHermesHint", {
    defaultValue: "由 Hermes 管理，请在 Hermes Web UI 中编辑",
  });
  const deleteHint =
    appId === "pi" && isStateChangeProtected
      ? piStateChangeHint
      : isReadOnly
        ? readOnlyHint
        : t("common.delete");

  return (
    <div className="flex min-w-48 flex-col gap-0.5 py-1.5">
      {/* 主动作：启用 / 切换 / 移除 / 加入故障转移 / 停用 OMO */}
      <button
        type="button"
        onClick={mainState.disabled ? undefined : handleMainAction}
        disabled={mainState.disabled}
        title={mainState.title}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs font-medium text-zinc-100",
          mainState.disabled
            ? "cursor-not-allowed opacity-40"
            : "hover:bg-blue-600/30 hover:text-blue-100",
        )}
      >
        {mainState.icon}
        {mainState.text}
      </button>

      {isDefaultModel && (
        <div className="flex items-center gap-2 px-3 py-1 text-[10px] text-emerald-400/80">
          <Check className="h-3 w-3" />
          {t("provider.isDefault", { defaultValue: "当前默认" })}
        </div>
      )}

      {(appId === "openclaw" || appId === "hermes") &&
        isInConfig &&
        onSetAsDefault &&
        !isDefaultModel && (
          <button
            type="button"
            onClick={() => onSetAsDefault(defaultModelOptions[0]?.id)}
            className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
          >
            <Zap className="h-3.5 w-3.5" />
            {appId === "hermes"
              ? t("provider.enable", { defaultValue: "启用" })
              : t("provider.setAsDefault", { defaultValue: "设为默认" })}
          </button>
        )}

      <div className="mx-3 my-1 h-px bg-zinc-800" />

      <button
        type="button"
        onClick={isReadOnly ? undefined : onEdit}
        disabled={isReadOnly}
        title={isReadOnly ? readOnlyHint : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800",
          isReadOnly && "cursor-not-allowed opacity-40",
        )}
      >
        <Edit className="h-3.5 w-3.5" />
        {t("common.edit")}
      </button>

      {onDuplicate && (
        <button
          type="button"
          onClick={onDuplicate}
          className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
        >
          <Copy className="h-3.5 w-3.5" />
          {t("provider.duplicate")}
        </button>
      )}

      {onTest && (
        <button
          type="button"
          onClick={onTest}
          disabled={isTesting}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800",
            isTesting && "cursor-not-allowed opacity-40",
          )}
        >
          {isTesting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Activity className="h-3.5 w-3.5" />
          )}
          {t("provider.connectivityCheck", "检测连通")}
        </button>
      )}

      {onConfigureUsage && (
        <button
          type="button"
          onClick={onConfigureUsage}
          className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
        >
          <BarChart3 className="h-3.5 w-3.5" />
          {t("provider.configureUsage")}
        </button>
      )}

      {onRefreshUsage && (
        <button
          type="button"
          onClick={onRefreshUsage}
          className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("usage.refreshUsage", { defaultValue: "刷新用量" })}
        </button>
      )}

      {onOpenTerminal && (
        <button
          type="button"
          onClick={onOpenTerminal}
          className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
        >
          <Terminal className="h-3.5 w-3.5" />
          {t("provider.openTerminal", "打开终端")}
        </button>
      )}

      {onRemoveFromConfig && !(isMembershipMode && isInConfig) && (
        <button
          type="button"
          onClick={onRemoveFromConfig}
          className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
        >
          <Minus className="h-3.5 w-3.5" />
          {t("provider.removeFromConfig", { defaultValue: "移除" })}
        </button>
      )}

      <div className="mx-3 my-1 h-px bg-zinc-800" />

      <button
        type="button"
        onClick={canDelete ? onDelete : undefined}
        disabled={!canDelete}
        title={deleteHint}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs",
          canDelete
            ? "text-red-400 hover:bg-red-500/10 hover:text-red-300"
            : "cursor-not-allowed opacity-40 text-zinc-500",
        )}
      >
        <Trash2 className="h-3.5 w-3.5" />
        {t("common.delete")}
      </button>
    </div>
  );
}