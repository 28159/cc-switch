import { isLinux, isMac, isWindows } from "@/lib/platform";

/**
 * 终端宿主的展示名。
 *
 * 复用设置页既有的 `settings.terminal.options.*` 文案，避免同一批终端名在两处
 * 各翻译一遍。检测出来但设置页没有收录的终端（如 `pwsh`、`xterm`）直接显示
 * 原始 id——比显示空白或错误的翻译更诚实。
 */

interface TerminalHostOption {
  value: string;
  labelKey?: string;
}

const MACOS_HOSTS: TerminalHostOption[] = [
  { value: "terminal", labelKey: "settings.terminal.options.macos.terminal" },
  { value: "iterm2", labelKey: "settings.terminal.options.macos.iterm2" },
  { value: "alacritty", labelKey: "settings.terminal.options.macos.alacritty" },
  { value: "kitty", labelKey: "settings.terminal.options.macos.kitty" },
  { value: "ghostty", labelKey: "settings.terminal.options.macos.ghostty" },
  { value: "wezterm", labelKey: "settings.terminal.options.macos.wezterm" },
  { value: "kaku", labelKey: "settings.terminal.options.macos.kaku" },
];

const WINDOWS_HOSTS: TerminalHostOption[] = [
  { value: "wt", labelKey: "settings.terminal.options.windows.wt" },
  {
    value: "powershell",
    labelKey: "settings.terminal.options.windows.powershell",
  },
  { value: "cmd", labelKey: "settings.terminal.options.windows.cmd" },
];

const LINUX_HOSTS: TerminalHostOption[] = [
  {
    value: "gnome-terminal",
    labelKey: "settings.terminal.options.linux.gnomeTerminal",
  },
  { value: "konsole", labelKey: "settings.terminal.options.linux.konsole" },
  {
    value: "xfce4-terminal",
    labelKey: "settings.terminal.options.linux.xfce4Terminal",
  },
  { value: "alacritty", labelKey: "settings.terminal.options.linux.alacritty" },
  { value: "kitty", labelKey: "settings.terminal.options.linux.kitty" },
  { value: "ghostty", labelKey: "settings.terminal.options.linux.ghostty" },
];

/** 当前平台已知的终端宿主（顺序即下拉展示顺序）。 */
export function getTerminalHostOptions(): TerminalHostOption[] {
  if (isMac()) return MACOS_HOSTS;
  if (isWindows()) return WINDOWS_HOSTS;
  if (isLinux()) return LINUX_HOSTS;
  return MACOS_HOSTS;
}

/** 当前平台的默认终端宿主。 */
export function getDefaultTerminalHost(): string {
  if (isWindows()) return "wt";
  if (isLinux()) return "gnome-terminal";
  return "terminal";
}

/**
 * 把后端检测到的终端 id 列表转成下拉选项。
 *
 * 检测列表优先（只显示这台机器上真实存在的终端）；不在已知表里的 id 也保留，
 * labelKey 留空由调用方回落到原始 id。
 */
export function buildHostOptions(
  detected: string[],
): Array<{ value: string; labelKey?: string }> {
  const known = getTerminalHostOptions();
  const options: Array<{ value: string; labelKey?: string }> = [];

  for (const id of detected) {
    const matched = known.find((item) => item.value === id);
    options.push(matched ? { ...matched } : { value: id });
  }

  // 后端探测失败时不让下拉空掉
  if (options.length === 0) {
    options.push(...known);
  }

  return options;
}
