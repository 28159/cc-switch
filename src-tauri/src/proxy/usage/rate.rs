//! 实时模型输出速率监控（滑动窗口采样）+ 会话用量 / 上下文统计。
//!
//! 采样粒度是「一次请求」：请求完成时记录其输出 token 总数与流式耗时，
//! 速率 = 窗口内输出 token / 活跃时长（各请求耗时之和与首尾跨度取大者）。
//! 这样单请求不会再因 span=0 被按 1 秒估算出荒谬的瞬时速率，
//! 并发请求也能正确累加吞吐。
//!
//! 除窗口速率外，另维护：
//! - 最近一次请求的输入（上下文长度）与输出、真实耗时 → 展示「上下文 Xk」与「上次 Y tok/s」；
//! - 会话累计的输入 / 输出 / 缓存用量 → 展示「当前的用量」；
//! - 流式在途的实时输出（字符级估算）→ 生成中显示实时速率。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::Serialize;

use super::parser::TokenUsage;

/// 采样窗口时长（秒）
const WINDOW_SECS: u64 = 60;
/// 实时「生成中」判定：超过该时长没有新文本增量视为已结束
const GENERATING_IDLE_MS: u64 = 3000;

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
/// 最近一次请求的输入（= 上下文长度）
static LAST_INPUT_TOKENS: AtomicU64 = AtomicU64::new(0);
/// 最近一次请求的输出
static LAST_OUTPUT_TOKENS: AtomicU64 = AtomicU64::new(0);
/// 会话累计用量（进程启动以来，分输入 / 输出 / 缓存）
static SESSION_INPUT: AtomicU64 = AtomicU64::new(0);
static SESSION_OUTPUT: AtomicU64 = AtomicU64::new(0);
static SESSION_CACHE: AtomicU64 = AtomicU64::new(0);
/// 流式实时输出（字符级，近似 token；仅用于生成中实时速率展示）
static LIVE_OUTPUT_CHARS: AtomicU64 = AtomicU64::new(0);
/// 最近一次实时增量的时间（epoch ms；0 = 无在途输出）
static LIVE_LAST_AT: AtomicU64 = AtomicU64::new(0);
/// 当前突发（一次流式输出）的起点
static LIVE_BURST_START: Mutex<Option<Instant>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 流式事件到达时记录文本增量（字符级，尽力估算；权威计数仍以请求结束时的
/// usage 为准）。在透传流的每个 SSE 事件上调用，用于生成中显示实时速率。
pub fn record_live_delta(event: &serde_json::Value) {
    let mut chars = 0usize;
    // Claude 系：{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}
    if let Some(text) = event.pointer("/delta/text").and_then(|v| v.as_str()) {
        chars += text.chars().count();
    }
    // OpenAI / opencode 系：{"choices":[{"delta":{"content":"…"}}]}
    if let Some(choices) = event.get("choices").and_then(|v| v.as_array()) {
        for choice in choices {
            if let Some(text) = choice.pointer("/delta/content").and_then(|v| v.as_str()) {
                chars += text.chars().count();
            }
        }
    }
    // Gemini 系：{"candidates":[{"content":{"parts":[{"text":"…"}]}}]}
    if let Some(candidates) = event.get("candidates").and_then(|v| v.as_array()) {
        for cand in candidates {
            if let Some(parts) = cand.pointer("/content/parts").and_then(|v| v.as_array()) {
                for part in parts {
                    if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                        chars += text.chars().count();
                    }
                }
            }
        }
    }
    if chars == 0 {
        return;
    }
    LIVE_OUTPUT_CHARS.fetch_add(chars as u64, Ordering::Relaxed);
    LIVE_LAST_AT.store(now_ms(), Ordering::Relaxed);
    let mut start = LIVE_BURST_START.lock().unwrap();
    if start.is_none() {
        *start = Some(Instant::now());
    }
}

/// 记录一次成功请求的用量（供速率统计与用量展示）。
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
    // 请求结束：更新「最近一次」与「会话累计」，并重置在途突发计数。
    // 放在 output==0 提前返回之前，保证缓存命中（0 输出）也计入上下文/用量。
    LAST_INPUT_TOKENS.store(usage.input_tokens as u64, Ordering::Relaxed);
    LAST_OUTPUT_TOKENS.store(usage.output_tokens as u64, Ordering::Relaxed);
    SESSION_INPUT.fetch_add(usage.input_tokens as u64, Ordering::Relaxed);
    SESSION_OUTPUT.fetch_add(usage.output_tokens as u64, Ordering::Relaxed);
    SESSION_CACHE.fetch_add(
        usage.cache_read_tokens as u64 + usage.cache_creation_tokens as u64,
        Ordering::Relaxed,
    );
    LIVE_OUTPUT_CHARS.store(0, Ordering::Relaxed);
    LIVE_LAST_AT.store(0, Ordering::Relaxed);
    *LIVE_BURST_START.lock().unwrap() = None;

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

/// 实时速率 / 用量信息（返回给前端）。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelRateInfo {
    /// 窗口平均输出速率（60s 滑动窗口，token/s）
    pub tokens_per_second: f64,
    /// 窗口内累计输出 token
    pub output_tokens: u64,
    pub sample_seconds: u64,
    /// 累计 token 消耗（含输入 / 缓存，进程启动以来）
    pub total_tokens: u64,
    /// 最近一次请求耗时（毫秒；无请求时为 0）
    pub last_duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_model: Option<String>,
    /// 最近一次请求的输入 token（= 上下文长度；无请求时为 0）
    pub last_input_tokens: u64,
    /// 最近一次请求的输出 token
    pub last_output_tokens: u64,
    /// 最近一次请求的真实速率（token/s；last_output / last_duration）
    pub last_speed_tok_s: f64,
    /// 会话累计输入 / 输出 / 缓存用量（进程启动以来）
    pub session_input_tokens: u64,
    pub session_output_tokens: u64,
    pub session_cache_tokens: u64,
    /// 当前是否有流式输出在途（近 3s 内有文本增量）
    pub generating: bool,
    /// 生成中的实时速率（字符级近似：按 4 字符 ≈ 1 token 估算）
    pub live_speed_tok_s: f64,
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
    info.last_input_tokens = LAST_INPUT_TOKENS.load(Ordering::Relaxed);
    info.last_output_tokens = LAST_OUTPUT_TOKENS.load(Ordering::Relaxed);
    let last_dur = info.last_duration_ms;
    info.last_speed_tok_s = if last_dur > 0 && info.last_output_tokens > 0 {
        info.last_output_tokens as f64 * 1000.0 / last_dur as f64
    } else {
        0.0
    };
    info.session_input_tokens = SESSION_INPUT.load(Ordering::Relaxed);
    info.session_output_tokens = SESSION_OUTPUT.load(Ordering::Relaxed);
    info.session_cache_tokens = SESSION_CACHE.load(Ordering::Relaxed);
    let live_chars = LIVE_OUTPUT_CHARS.load(Ordering::Relaxed);
    let live_at = LIVE_LAST_AT.load(Ordering::Relaxed);
    info.generating = live_at > 0 && now.saturating_sub(live_at) < GENERATING_IDLE_MS;
    if info.generating && live_chars > 0 {
        let start = *LIVE_BURST_START.lock().unwrap().get_or_insert_with(Instant::now);
        let secs = start.elapsed().as_secs_f64().max(0.5);
        // 字符 → token 近似（约 4 字符/token），仅用于生成中实时展示
        info.live_speed_tok_s = live_chars as f64 / 4.0 / secs;
    }
    info
}

#[tauri::command]
pub fn get_model_rate() -> ModelRateInfo {
    current_rate()
}
