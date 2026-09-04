# =============================================================================
# CC Switch Windows 发布打包脚本 (优化版)
#
# 用法（在项目根目录执行）：
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1 -Target msi
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1 -SkipInstall -CleanLock
#
# 参数：
#   -Target       打包目标：nsis（默认）/ msi / all
#   -SkipInstall  跳过 pnpm install
#   -OutDir       产物输出目录（默认 ./release）
#   -CleanLock    构建前自动清理 cargo 锁文件（解决 Blocking waiting for file lock）
#   -Verbose      显示 tauri build 的详细输出
# =============================================================================

param(
    [ValidateSet("nsis", "msi", "all")]
    [string]$Target = "nsis",
    [switch]$SkipInstall,
    [string]$OutDir = "release",
    [switch]$CleanLock,
    [switch]$VerboseBuild
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "==> CC Switch Windows 发布打包开始 (Target=$Target)" -ForegroundColor Cyan
Write-Host "    项目根目录: $Root" -ForegroundColor DarkGray
Write-Host "    当前时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray

# -----------------------------------------------------------------------------
# 0. 预检查 & 锁清理
# -----------------------------------------------------------------------------
if ($CleanLock) {
    Write-Host "==> 清理 Cargo 锁文件 (-CleanLock)..." -ForegroundColor Yellow
    $lockFiles = @(
        (Join-Path $Root "src-tauri\target\.cargo-lock"),
        (Join-Path $Root "src-tauri\target\.package-cache")
    )
    foreach ($lf in $lockFiles) {
        if (Test-Path $lf) {
            Remove-Item -LiteralPath $lf -Force -ErrorAction SilentlyContinue
            Write-Host "  已删除: $lf" -ForegroundColor DarkYellow
        }
    }
}

# 检查是否有残留的 cargo/rustc 进程占用
$blockingProcs = Get-Process -Name "cargo","rustc","cc-switch" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "*cc_switch_workbench*" }
if ($blockingProcs) {
    Write-Host "⚠ 检测到残留构建进程，可能导致文件锁阻塞:" -ForegroundColor Red
    $blockingProcs | ForEach-Object { Write-Host "  PID=$($_.Id) Name=$($_.Name)" -ForegroundColor Red }
    $confirm = Read-Host "是否终止这些进程？(Y/n)"
    if ($confirm -ne 'n' -and $confirm -ne 'N') {
        $blockingProcs | Stop-Process -Force
        Write-Host "  已终止残留进程" -ForegroundColor Green
        Start-Sleep -Seconds 2
    } else {
        Write-Host "  保留进程，构建可能阻塞..." -ForegroundColor Yellow
    }
}

# -----------------------------------------------------------------------------
# 1. 安装依赖
# -----------------------------------------------------------------------------
if (-not $SkipInstall) {
    Write-Host "==> pnpm install ..." -ForegroundColor Yellow
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "❌ pnpm install 失败 (exit code: $LASTEXITCODE)" }
} else {
    Write-Host "==> 跳过 pnpm install (-SkipInstall)" -ForegroundColor Yellow
}

# -----------------------------------------------------------------------------
# 2. Tauri Release 构建
# -----------------------------------------------------------------------------
$tauriArgs = @("tauri", "build", "--bundles", $Target)
if ($VerboseBuild) { $tauriArgs += "--verbose" }

Write-Host "==> pnpm $($tauriArgs -join ' ')" -ForegroundColor Yellow
Write-Host "    ⏱ Release 编译较久，请耐心等待..." -ForegroundColor DarkGray

$buildStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
& pnpm @tauriArgs
$buildExitCode = $LASTEXITCODE
$buildStopwatch.Stop()

$elapsed = $buildStopwatch.Elapsed.ToString("hh\:mm\:ss")
if ($buildExitCode -ne 0) {
    Write-Host "❌ tauri build 失败 (exit code: $buildExitCode, 耗时: $elapsed)" -ForegroundColor Red
    throw "tauri build 失败"
}
Write-Host "✅ tauri build 完成 (耗时: $elapsed)" -ForegroundColor Green

# -----------------------------------------------------------------------------
# 3. 收集产物
# -----------------------------------------------------------------------------
Write-Host "==> 收集产物..." -ForegroundColor Yellow
$bundleRoot = Join-Path $Root "src-tauri\target\release\bundle"
$artifacts = [System.Collections.Generic.List[string]]::new()

# 主程序 exe
$mainExe = Join-Path $Root "src-tauri\target\release\cc-switch.exe"
if (Test-Path $mainExe) { $artifacts.Add($mainExe) }

# NSIS / MSI 产物
$bundleTypes = switch ($Target) {
    "nsis" { @("nsis") }
    "msi"  { @("msi") }
    "all"  { @("nsis", "msi") }
}

foreach ($bt in $bundleTypes) {
    $bundleDir = Join-Path $bundleRoot $bt
    if (Test-Path $bundleDir) {
        Get-ChildItem $bundleDir -File |
            Where-Object { $_.Extension -in @(".exe", ".msi", ".sig") } |
            ForEach-Object { $artifacts.Add($_.FullName) }
    }
}

if ($artifacts.Count -eq 0) {
    throw "❌ 未找到任何构建产物，请检查上方日志"
}

# -----------------------------------------------------------------------------
# 4. 拷贝到输出目录
# -----------------------------------------------------------------------------
$out = Join-Path $Root $OutDir
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host "==> 拷贝 $($artifacts.Count) 个产物到: $out" -ForegroundColor Yellow
foreach ($file in $artifacts) {
    $dest = Join-Path $out (Split-Path $file -Leaf)
    Copy-Item -LiteralPath $file -Destination $dest -Force
    $size = [math]::Round((Get-Item $dest).Length / 1MB, 2)
    Write-Host "  -> $(Split-Path $dest -Leaf) ($size MB)" -ForegroundColor Green
}

# -----------------------------------------------------------------------------
# 5. 汇总报告
# -----------------------------------------------------------------------------
$setupFiles = Get-ChildItem $out -File | Where-Object { $_.Name -match 'setup|\.msi' }
Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║         🎉 打包完成！                    ║" -ForegroundColor Green
Write-Host "╠══════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║ 产物目录: $out" -ForegroundColor Green
foreach ($sf in $setupFiles) {
    $sz = [math]::Round($sf.Length / 1MB, 2)
    Write-Host "║ 📦 $($sf.Name) ($sz MB)" -ForegroundColor Green
}
Write-Host "║ ⏱ 总构建耗时: $elapsed" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Green