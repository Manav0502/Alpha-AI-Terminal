// commands/sentiment.rs — Standalone Sentiment Fetch (Decoupled from Kafka/WS).
//
// This Tauri command fetches news headlines for a symbol and runs them
// through the LLM to produce a sentiment score. It operates completely
// independently of the OHLC tick pipeline, so it works even when the
// market is closed and no WebSocket data is flowing.

use log::{info, warn, error};
use serde::{Deserialize, Serialize};
use std::time::Instant;

// ── Payload returned to the frontend ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SentimentPayload {
    pub symbol: String,
    pub score: i32,          // -100 to +100
    pub label: String,       // "Bullish", "Bearish", "Neutral"
    pub top_headline: String,
    pub impact: String,      // "positive", "negative", "neutral"
    pub headlines: Vec<String>, // All fetched headlines for individual display
}

// ── LLM response shape ─────────────────────────────────────────────────────

#[derive(Deserialize)]
struct LlmSentimentResponse {
    score: Option<i32>,
    label: Option<String>,
    top_headline: Option<String>,
    impact: Option<String>,
}

// ── News fetcher — Google News RSS (zero API keys required) ─────────────────
//
// Primary: Google News RSS for the stock symbol (always available, no auth).
// Fallback: Local NEWS_API_URL if configured and reachable.

async fn fetch_news_headlines(symbol: &str) -> Vec<String> {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            warn!("[sentiment] HTTP client build failed: {}", e);
            return Vec::new();
        }
    };

    // ── Primary: Google News RSS ────────────────────────────────────────
    let google_news = fetch_google_news_rss(&client, symbol).await;
    if !google_news.is_empty() {
        info!(
            "[sentiment] Google News RSS returned {} headlines for {}",
            google_news.len(),
            symbol
        );
        return google_news;
    }

    // ── Fallback: Local NEWS_API_URL ────────────────────────────────────
    let news_api_url = std::env::var("NEWS_API_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8084".to_string());
    let url = format!("{}/api/news?symbol={}", news_api_url, symbol);

    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let body = resp.text().await.unwrap_or_default();
            if !body.trim().is_empty() && !body.contains("No recent news") {
                info!("[sentiment] Local news API returned data for {}", symbol);
                return body.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
            }
        }
        _ => {
            warn!("[sentiment] Local news API unavailable for {}", symbol);
        }
    }

    Vec::new()
}

/// Scrape headlines from Google News RSS feed. No API key required.
/// Returns up to 10 recent headlines as plain strings.
async fn fetch_google_news_rss(client: &reqwest::Client, symbol: &str) -> Vec<String> {
    // Google News RSS search — works for Indian stocks (e.g. "RELIANCE stock NSE")
    let query = format!("{} stock NSE India", symbol);
    let rss_url = format!(
        "https://news.google.com/rss/search?q={}&hl=en-IN&gl=IN&ceid=IN:en",
        urlencoding::encode(&query)
    );

    let body = match client
        .get(&rss_url)
        .header("User-Agent", "Mozilla/5.0 (compatible; AlphaSuite/1.0)")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            resp.text().await.unwrap_or_default()
        }
        Ok(resp) => {
            warn!("[sentiment] Google News RSS returned HTTP {}", resp.status());
            return Vec::new();
        }
        Err(e) => {
            warn!("[sentiment] Google News RSS fetch failed: {}", e);
            return Vec::new();
        }
    };

    // Extract <title> tags from RSS XML via simple string parsing.
    // RSS items look like: <item><title>Headline text here</title>...
    // Skip the first <title> (channel title, usually "RELIANCE stock NSE India - Google News")
    let mut headlines: Vec<String> = Vec::new();
    let mut search_from = 0usize;

    loop {
        let start_tag = match body[search_from..].find("<title>") {
            Some(pos) => search_from + pos + 7, // skip "<title>"
            None => break,
        };
        let end_tag = match body[start_tag..].find("</title>") {
            Some(pos) => start_tag + pos,
            None => break,
        };

        let raw = &body[start_tag..end_tag];
        search_from = end_tag + 8; // skip "</title>"

        // Decode basic XML entities
        let decoded = raw
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("<![CDATA[", "")
            .replace("]]>", "");

        let trimmed = decoded.trim().to_string();

        // Skip empty, channel-level titles, and junk entries
        if trimmed.is_empty()
            || trimmed == "Google News"
            || trimmed.starts_with("\"")
            || trimmed.len() < 10
        {
            continue;
        }

        headlines.push(trimmed);

        if headlines.len() >= 10 {
            break;
        }
    }

    headlines
}

// ── LLM Sentiment Analysis ─────────────────────────────────────────────────

const SENTIMENT_SYSTEM_PROMPT: &str = "\
You are a Financial News Sentiment Analyst. \
You will be provided with recent news headlines for a specific stock. \
Analyze the overall sentiment and output strictly in JSON format with exactly four keys: \
'score' (integer -100 to +100, where +100 is extremely bullish and -100 is extremely bearish), \
'label' (string: \"Bullish\", \"Bearish\", or \"Neutral\"), \
'top_headline' (the single most impactful headline from the provided news), \
and 'impact' (string: \"positive\", \"negative\", or \"neutral\"). \
Do NOT include any text outside the JSON object. Do NOT wrap in markdown code fences. \
Output ONLY the raw JSON object.";

async fn analyze_sentiment_via_llm(symbol: &str, news: &str, headlines: Vec<String>) -> Result<SentimentPayload, String> {
    use crate::services::llm::{ChatMessage, ChatRequest};

    let api_url = resolve_llm_endpoint();
    let api_key = resolve_llm_key()?;
    let model = resolve_llm_model();

    let user_prompt = format!(
        "Stock: {symbol}\n\nRecent News Headlines:\n{news}",
        symbol = symbol,
        news = news,
    );

    let request_body = ChatRequest {
        model: model.clone(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: SENTIMENT_SYSTEM_PROMPT.to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: user_prompt,
            },
        ],
        temperature: 0.2,
        max_tokens: 512,
        response_format: None,
    };

    let timeout_secs: u64 = std::env::var("LLM_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("HTTP client build failed: {}", e))?;

    let response = client
        .post(&api_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Sentiment LLM request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("Sentiment LLM returned HTTP {}", status));
    }

    // Parse OpenAI-compatible envelope
    #[derive(Deserialize)]
    struct Envelope { choices: Vec<Choice> }
    #[derive(Deserialize)]
    struct Choice { message: Msg }
    #[derive(Deserialize)]
    struct Msg { content: String }

    let envelope: Envelope = serde_json::from_str(&body)
        .map_err(|e| format!("Sentiment envelope parse failed: {}", e))?;

    let content = envelope
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .ok_or_else(|| "Empty choices in sentiment response".to_string())?;

    // ── Robust JSON extraction ──────────────────────────────────────────
    // The LLM sometimes outputs text before/after the JSON, wraps it in
    // markdown fences, or outputs pure prose with no JSON at all.
    // Strategy:
    //   1. Find the first '{' and last '}' — handles surrounding text & fences.
    //   2. If no '{' found → the model output prose (wrong model / rate limit).
    //      Return a neutral fallback payload so the UI stays functional.
    let start = content.find('{');
    let end   = content.rfind('}');

    let extracted: &str = match (start, end) {
        (Some(s), Some(e)) if e >= s => &content[s..=e],
        _ => {
            // No JSON object found at all — model output pure prose.
            // Log the snippet for diagnosis, return a neutral payload.
            warn!(
                "[sentiment] LLM returned prose (no JSON) for {} — model may be wrong. \
                 Raw snippet: {:?}",
                symbol,
                &content[..content.len().min(200)]
            );
            // Return a neutral fallback — the headline list is still shown.
            let top = headlines.first().cloned()
                .unwrap_or_else(|| format!("No notable headline for {}.", symbol));
            return Ok(SentimentPayload {
                symbol: symbol.to_string(),
                score: 0,
                label: "Neutral".to_string(),
                top_headline: top,
                impact: "neutral".to_string(),
                headlines,
            });
        }
    };

    let parsed: LlmSentimentResponse = serde_json::from_str(extracted).map_err(|e| {
        error!(
            "[sentiment] JSON parse failed for {}: {} | raw (first 400 chars): {:?}",
            symbol, e, &content[..content.len().min(400)]
        );
        format!("Sentiment JSON parse failed: {} | snippet: {:?}", e, &extracted[..extracted.len().min(100)])
    })?;

    let score = parsed.score.unwrap_or(0).clamp(-100, 100);
    let label = parsed.label.unwrap_or_else(|| {
        if score > 20 { "Bullish".to_string() }
        else if score < -20 { "Bearish".to_string() }
        else { "Neutral".to_string() }
    });
    let impact = parsed.impact.unwrap_or_else(|| {
        if score > 20 { "positive".to_string() }
        else if score < -20 { "negative".to_string() }
        else { "neutral".to_string() }
    });
    let top_headline = parsed.top_headline
        .unwrap_or_else(|| format!("No notable headline for {}.", symbol));

    Ok(SentimentPayload {
        symbol: symbol.to_string(),
        score,
        label,
        top_headline,
        impact,
        headlines,
    })
}

// ── LLM Config Resolution (unified — reads LLM_API_URL, LLM_API_KEY, LLM_MODEL) ──

fn resolve_llm_endpoint() -> String {
    std::env::var("LLM_API_URL")
        .unwrap_or_else(|_| "https://router.huggingface.co/v1/chat/completions".to_string())
}

fn resolve_llm_model() -> String {
    std::env::var("LLM_MODEL")
        .unwrap_or_else(|_| "deepseek-ai/DeepSeek-V3-0324".to_string())
}

fn resolve_llm_key() -> Result<String, String> {
    if let Ok(key) = std::env::var("LLM_API_KEY") {
        if !key.trim().is_empty() {
            return Ok(key);
        }
    }
    if crate::is_test_mode() {
        return Ok("TEST_KEY".to_string());
    }
    Err("No LLM_API_KEY configured in .env".to_string())
}

// ── Mock for test mode ──────────────────────────────────────────────────────

fn mock_sentiment(symbol: &str) -> SentimentPayload {
    SentimentPayload {
        symbol: symbol.to_string(),
        score: 42,
        label: "Bullish".to_string(),
        top_headline: format!("{} reports strong quarterly earnings, beating analyst estimates by 12%.", symbol),
        impact: "positive".to_string(),
        headlines: vec![
            format!("{} reports strong quarterly earnings, beating analyst estimates by 12%.", symbol),
            format!("{} announces expansion into renewable energy sector.", symbol),
            format!("Analysts upgrade {} to 'Outperform' with revised target price.", symbol),
        ],
    }
}

// ── Tauri IPC Command ───────────────────────────────────────────────────────

/// Fetch sentiment for a symbol — fully independent of WebSocket/Kafka streams.
///
/// # Frontend Usage
/// ```typescript
/// const sentiment = await invoke<SentimentPayload>("fetch_symbol_sentiment", {
///   symbol: "RELIANCE"
/// });
/// ```
#[tauri::command]
pub async fn fetch_symbol_sentiment(symbol: String) -> Result<SentimentPayload, String> {
    let t0 = Instant::now();
    info!("[sentiment] ▶ Fetching sentiment for {} (decoupled from ticks)", symbol);

    // Test mode → return mock immediately
    if crate::is_test_mode() {
        let mock = mock_sentiment(&symbol);
        info!(
            "[sentiment] ✔ TEST_MODE mock returned score={} label={} elapsed_ms={}",
            mock.score, mock.label, t0.elapsed().as_millis()
        );
        return Ok(mock);
    }

    // Step 1: Fetch news headlines (independent HTTP call)
    let t_news = Instant::now();
    let headlines = fetch_news_headlines(&symbol).await;
    let news_text = if headlines.is_empty() {
        format!("No recent news available for {}.", symbol)
    } else {
        headlines.iter().enumerate()
            .map(|(i, h)| format!("{}. {}", i + 1, h))
            .collect::<Vec<_>>()
            .join("\n")
    };
    info!(
        "[sentiment] step=news_fetch elapsed_ms={} headlines={}",
        t_news.elapsed().as_millis(),
        headlines.len()
    );

    // Step 2: Analyze via LLM
    let t_llm = Instant::now();
    let payload = analyze_sentiment_via_llm(&symbol, &news_text, headlines).await.map_err(|e| {
        error!(
            "[sentiment] ✘ LLM analysis failed for {} elapsed_ms={}: {}",
            symbol, t_llm.elapsed().as_millis(), e
        );
        e
    })?;

    info!(
        "[sentiment] ✔ Done symbol={} score={} label={} impact={} total_ms={}",
        symbol, payload.score, payload.label, payload.impact, t0.elapsed().as_millis()
    );

    Ok(payload)
}
