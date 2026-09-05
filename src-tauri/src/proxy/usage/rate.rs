//! 实时模型输出速率监控（滑动窗口采样）。
//!
//! 采样粒度是「一次请求」：请求完成时记录其输出 token 总数与流式耗时，
//! 速率 = 窗口内输出 token / 活跃时长（各请求耗时之和与首尾跨度取大者）。
//! 这样单请求不会再因 span=0 被按 1 秒估算出荒谬的瞬时速率，
//! 并发请求也能正确累加吞吐。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::Serialize;

use super::parser::TokenUsage;

/// 采样窗口时长（秒）
const WINDOW_SECS: u64 = 60;

struct RateSample {
    at_ms: u64,
    /// 该请求自身的流式耗时（首个样本被用于推算窗口起点）
    duration_ms: u64,
    output_tokens: u64,
}

static SAMPLES: Lazy<Mutex<VecDeque<RateSample>>> = Lazy::new(|| Mutex::new(VecDeque::new()));
static LAST_MODEL: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
/// 累计 token 消耗（input + output + cache，进程生命周期内）
static TOTAL_TOKENS: AtomicU64 = AtomicU64::new(0);
/// 最近一次请求的耗时（毫秒）
static LAST_DURATION_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 记录一次成功请求的输出 token（供速率统计）。
///
/// `duration_ms` 为该请求从发出到收到完整响应的耗时：速率分母按真实
/// 流式时长计算，而不是把整段输出压进一个时间点。
pub fn record_output(usage: &TokenUsage, duration_ms: u64) {
    let total = usage.input_tokens as u64
        + usage.output_tokens as u64
        + usage.cache_read_tokens as u64
        + usage.cache_creation_tokens as u64;
    TOTAL_TOKENS.fetch_add(total, Ordering::Relaxed);
    LAST_DURATION_MS.store(duration_ms, Ordering::Relaxed);

    if usage.output_tokens == 0 {
        return;
    }
    let now = now_ms();
    let sample = RateSample {
        at_ms: now,
        duration_ms,
        output_tokens: usage.output_tokens as u64,
    };
    let mut samples = SAMPLES.lock().unwrap();
    samples.push_back(sample);
    let cutoff = now.saturating_sub(WINDOW_SECS * 1000);
    while samples.front().map(|s| s.at_ms < cutoff).unwrap_or(false) {
        samples.pop_front();
    }
}

/// 实时速率信息（返回给前端）。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelRateInfo {
    pub tokens_per_second: f64,
    pub output_tokens: u64,
    pub sample_seconds: u64,
    /// 累计 token 消耗（含输入 / 缓存，进程启动以来）
    pub total_tokens: u64,
    /// 最近一次请求耗时（毫秒；无请求时为 0）
    pub last_duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_model: Option<String>,
}

/// 当前实时速率。
pub fn current_rate() -> ModelRateInfo {
    let now = now_ms();
    let cutoff = now.saturating_sub(WINDOW_SECS * 1000);
    let mut info = ModelRateInfo::default();
    {
        let mut samples = SAMPLES.lock().unwrap();
        // 读取时按当前时间清理过期样本：空闲 60s 后速率归零，
        // 而不是冻结在最后一次请求的数值上
        while samples.front().map(|s| s.at_ms < cutoff).unwrap_or(false) {
            samples.pop_front();
        }
        if let Some(first) = samples.front() {
            let last = samples.back().unwrap();
            let output = samples.iter().map(|s| s.output_tokens).sum::<u64>();
            // 活跃时长：各请求自身流式耗时之和（并发请求正确累加），
            // 与「首个请求起点 → 最后一个样本」的窗口跨度取大者
            let duration_sum_ms = samples.iter().map(|s| s.duration_ms).sum::<u64>();
            let earliest_start = first.at_ms.saturating_sub(first.duration_ms);
            let span_ms = last.at_ms.saturating_sub(earliest_start);
            let active_secs = (duration_sum_ms.max(span_ms) as f64 / 1000.0).max(1.0);
            info.tokens_per_second = output as f64 / active_secs;
            info.output_tokens = output;
            info.sample_seconds = (span_ms / 1000).max(1);
        }
    }
    info.last_model = LAST_MODEL.lock().unwrap().clone();
    info.total_tokens = TOTAL_TOKENS.load(Ordering::Relaxed);
    info.last_duration_ms = LAST_DURATION_MS.load(Ordering::Relaxed);
    info
}

#[tauri::command]
pub fn get_model_rate() -> ModelRateInfo {
    current_rate()
}
