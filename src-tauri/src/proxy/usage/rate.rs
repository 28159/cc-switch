//! 实时模型输出速率监控（滑动窗口采样）。

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::Serialize;

use super::parser::TokenUsage;

/// 采样窗口时长（秒）
const WINDOW_SECS: u64 = 60;

struct RateSample {
    at_ms: u64,
    output_tokens: u64,
}

static SAMPLES: Lazy<Mutex<VecDeque<RateSample>>> = Lazy::new(|| Mutex::new(VecDeque::new()));
static LAST_MODEL: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 记录一次成功请求的输出 token（供速率统计）。
pub fn record_output(usage: &TokenUsage) {
    if usage.output_tokens == 0 {
        return;
    }
    let sample = RateSample {
        at_ms: now_ms(),
        output_tokens: usage.output_tokens as u64,
    };
    {
        let mut samples = SAMPLES.lock().unwrap();
        samples.push_back(sample);
        let cutoff = now_ms().saturating_sub(WINDOW_SECS * 1000);
        while samples.front().map(|s| s.at_ms < cutoff).unwrap_or(false) {
            samples.pop_front();
        }
    }
    if let Some(model) = usage.model.as_ref() {
        if let Ok(mut last) = LAST_MODEL.lock() {
            *last = Some(model.clone());
        }
    }
}

/// 实时速率信息（返回给前端）。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelRateInfo {
    pub tokens_per_second: f64,
    pub output_tokens: u64,
    pub sample_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_model: Option<String>,
}

/// 当前实时速率。
pub fn current_rate() -> ModelRateInfo {
    let mut info = ModelRateInfo::default();
    let samples = SAMPLES.lock().unwrap();
    if let Some(first) = samples.front() {
        let last = samples.back().unwrap();
        let span_ms = last.at_ms.saturating_sub(first.at_ms);
        let span_secs = (span_ms as f64 / 1000.0).max(0.05);
        let output = samples.iter().map(|s| s.output_tokens).sum::<u64>();
        info.tokens_per_second = output as f64 / span_secs;
        info.output_tokens = output;
        info.sample_seconds = (span_ms / 1000).max(1);
    }
    drop(samples);
    info.last_model = LAST_MODEL.lock().unwrap().clone();
    info
}

#[tauri::command]
pub fn get_model_rate() -> ModelRateInfo {
    current_rate()
}