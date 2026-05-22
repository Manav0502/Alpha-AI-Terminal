// engine.rs — Dynamic Weighting & Conflict Resolution Engine.
//
// Master Phase 1 → Power Phase 1.5 → Subphase 41.
//
// The proprietary algorithm that decides when math matters more than news,
// and vice-versa. Fuses a TechSignal with optional NewsSentiment into a
// single AggregatedDecision with actionable BUY / SELL / HOLD output.
//
// Algorithm overview:
//   1. Base Case     — No sentiment → 100% Technical.
//   2. Dynamic Shift — Base weights: 70% Tech / 30% Sentiment.
//   3. Conviction Override — If Claude's conviction > 85 → invert to 30% Tech / 70% Sentiment.
//   4. Conflict Resolution — Extreme bearish tech + extreme bullish sentiment →
//      penalize toward 50 (Neutral), UNLESS conviction override is active.
//   5. Action Mapping — BUY > 65, SELL < 35, HOLD otherwise.

use crate::proto::decision::{ActionType, AggregatedDecision};
use crate::proto::sentiment_data::NewsSentiment;
use crate::proto::technical_data::TechSignal;

// ── Weight constants ─────────────────────────────────────────────────────

/// Default weight for technical signal (70%).
const BASE_TECH_WEIGHT: f64 = 0.70;

/// Default weight for sentiment signal (30%).
const BASE_SENT_WEIGHT: f64 = 0.30;

/// Inverted weight for technical signal when conviction override fires (30%).
const OVERRIDE_TECH_WEIGHT: f64 = 0.30;

/// Inverted weight for sentiment signal when conviction override fires (70%).
const OVERRIDE_SENT_WEIGHT: f64 = 0.70;

/// Claude conviction threshold above which weights are inverted.
/// Strong news at this level historically breaks technical patterns.
const CONVICTION_OVERRIDE_THRESHOLD: i32 = 85;

// ── Conflict Resolution thresholds ───────────────────────────────────────

/// Tech score below which the signal is considered "extremely bearish".
const EXTREME_BEARISH_TECH: f64 = 20.0;

/// Sentiment score above which the signal is considered "extremely bullish".
const EXTREME_BULLISH_SENT: i32 = 80;

/// Neutral target score — conflict resolution drags blended score here.
const CONFLICT_NEUTRAL: f64 = 50.0;

/// How heavily to penalize toward neutral during conflict (0.0 = no penalty, 1.0 = full snap).
/// 0.6 means 60% of the distance to neutral is applied as penalty.
const CONFLICT_PENALTY_FACTOR: f64 = 0.60;

// ── Action mapping thresholds ────────────────────────────────────────────

#[cfg(feature = "kafka")]
const BUY_THRESHOLD: f64 = 65.0;

#[cfg(feature = "kafka")]
const SELL_THRESHOLD: f64 = 35.0;

/// Calculates the aggregated decision by blending a technical signal with
/// optional sentiment context.
///
/// # Arguments
/// * `tech` — The latest `TechSignal` from the technical agent.
/// * `latest_sentiment` — The most recent `NewsSentiment` for this symbol,
///   or `None` if no sentiment has been received yet.
///
/// # Returns
/// A fully populated `AggregatedDecision` ready for Kafka publishing or
/// console output.
#[cfg(feature = "kafka")]
pub fn calculate_decision(
    tech: &TechSignal,
    latest_sentiment: Option<&NewsSentiment>,
) -> AggregatedDecision {
    let tech_score = tech.technical_conviction_score as f64;

    // ── 1. Base Case: No sentiment → 100% Technical ─────────────────────
    let (final_score, tech_weight, sent_weight) = match latest_sentiment {
        None => (tech_score, 1.0_f64, 0.0_f64),

        Some(sentiment) => {
            let sent_score = sentiment.claude_conviction_score as f64;

            // ── 2. Determine weights (base vs conviction override) ──────
            let conviction_override =
                sentiment.claude_conviction_score > CONVICTION_OVERRIDE_THRESHOLD;

            let (tw, sw) = if conviction_override {
                // Strong news breaks technical patterns → invert weights.
                (OVERRIDE_TECH_WEIGHT, OVERRIDE_SENT_WEIGHT)
            } else {
                (BASE_TECH_WEIGHT, BASE_SENT_WEIGHT)
            };

            // ── 3. Compute weighted blend ───────────────────────────────
            let mut blended = (tech_score * tw) + (sent_score * sw);

            // ── 4. Conflict Resolution ──────────────────────────────────
            // If tech is extremely bearish BUT sentiment is extremely bullish,
            // the signals fundamentally disagree. In this case:
            //   - If conviction override is active → trust the news (skip penalty).
            //   - Otherwise → heavily penalize toward neutral to avoid risky trades.
            let is_conflict =
                tech_score < EXTREME_BEARISH_TECH && sentiment.claude_conviction_score > EXTREME_BULLISH_SENT;

            if is_conflict && !conviction_override {
                // Pull the blended score toward neutral proportionally.
                let distance_to_neutral = blended - CONFLICT_NEUTRAL;
                blended -= distance_to_neutral * CONFLICT_PENALTY_FACTOR;
            }

            (blended, tw, sw)
        }
    };

    // ── 5. Clamp to valid range [1, 100] ────────────────────────────────
    let clamped_score = final_score.round().clamp(1.0, 100.0) as i32;

    // ── 6. Action Mapping ───────────────────────────────────────────────
    let action = if final_score > BUY_THRESHOLD {
        ActionType::Buy
    } else if final_score < SELL_THRESHOLD {
        ActionType::Sell
    } else {
        ActionType::Hold
    };

    AggregatedDecision {
        symbol: tech.symbol.clone(),
        timestamp_ms: tech.timestamp_ms,
        final_conviction_score: clamped_score,
        technical_weight_used: tech_weight,
        sentiment_weight_used: sent_weight,
        action_type: action.into(),
    }
}

// ── Unit Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: build a TechSignal with a given score.
    fn make_tech(symbol: &str, score: i32) -> TechSignal {
        TechSignal {
            symbol: symbol.to_string(),
            timestamp_ms: 1700000000000,
            rsi_value: 50.0,
            vwap_distance: 0.5,
            technical_conviction_score: score,
        }
    }

    /// Helper: build a NewsSentiment with a given conviction score.
    fn make_sentiment(symbol: &str, score: i32) -> NewsSentiment {
        NewsSentiment {
            symbol: symbol.to_string(),
            timestamp_ms: 1700000000000,
            headline: "Test headline".to_string(),
            claude_conviction_score: score,
            reasoning_snippet: "Test reasoning".to_string(),
        }
    }

    #[test]
    fn base_case_no_sentiment_100pct_tech() {
        let tech = make_tech("RELIANCE", 75);
        let decision = calculate_decision(&tech, None);

        assert_eq!(decision.final_conviction_score, 75);
        assert_eq!(decision.technical_weight_used, 1.0);
        assert_eq!(decision.sentiment_weight_used, 0.0);
        assert_eq!(decision.action_type, ActionType::Buy as i32);
    }

    #[test]
    fn base_weights_70_30_normal() {
        let tech = make_tech("INFY", 80);
        let sentiment = make_sentiment("INFY", 60);
        let decision = calculate_decision(&tech, Some(&sentiment));

        // 80 * 0.70 + 60 * 0.30 = 56 + 18 = 74
        assert_eq!(decision.final_conviction_score, 74);
        assert_eq!(decision.technical_weight_used, 0.70);
        assert_eq!(decision.sentiment_weight_used, 0.30);
        assert_eq!(decision.action_type, ActionType::Buy as i32);
    }

    #[test]
    fn conviction_override_inverts_weights() {
        let tech = make_tech("TCS", 40);
        let sentiment = make_sentiment("TCS", 90); // > 85 threshold
        let decision = calculate_decision(&tech, Some(&sentiment));

        // 40 * 0.30 + 90 * 0.70 = 12 + 63 = 75
        assert_eq!(decision.final_conviction_score, 75);
        assert_eq!(decision.technical_weight_used, 0.30);
        assert_eq!(decision.sentiment_weight_used, 0.70);
        assert_eq!(decision.action_type, ActionType::Buy as i32);
    }

    #[test]
    fn conflict_resolution_penalizes_toward_neutral() {
        // Tech extremely bearish (score=15 < 20) + Sentiment extremely bullish (score=82 > 80)
        // BUT conviction is NOT > 85 → conflict penalty applies.
        let tech = make_tech("HDFCBANK", 15);
        let sentiment = make_sentiment("HDFCBANK", 82);
        let decision = calculate_decision(&tech, Some(&sentiment));

        // blended = 15 * 0.70 + 82 * 0.30 = 10.5 + 24.6 = 35.1
        // conflict detected: distance_to_neutral = 35.1 - 50 = -14.9
        // blended -= (-14.9 * 0.60) → blended -= (-8.94) → blended = 35.1 + 8.94 = 44.04
        // rounded = 44
        assert_eq!(decision.final_conviction_score, 44);
        assert_eq!(decision.action_type, ActionType::Hold as i32); // 35 <= 44 <= 65
    }

    #[test]
    fn conflict_with_conviction_override_trusts_news() {
        // Tech extremely bearish (score=15 < 20) + Sentiment extremely bullish AND conviction > 85
        // Conviction override active → skip conflict penalty → trust the news.
        let tech = make_tech("WIPRO", 15);
        let sentiment = make_sentiment("WIPRO", 90);
        let decision = calculate_decision(&tech, Some(&sentiment));

        // Inverted weights: 15 * 0.30 + 90 * 0.70 = 4.5 + 63 = 67.5 → 68
        assert_eq!(decision.final_conviction_score, 68);
        assert_eq!(decision.action_type, ActionType::Buy as i32);
    }

    #[test]
    fn sell_action_on_bearish_blend() {
        let tech = make_tech("SBILIFE", 20);
        let sentiment = make_sentiment("SBILIFE", 30);
        let decision = calculate_decision(&tech, Some(&sentiment));

        // 20 * 0.70 + 30 * 0.30 = 14 + 9 = 23
        assert_eq!(decision.final_conviction_score, 23);
        assert_eq!(decision.action_type, ActionType::Sell as i32);
    }

    #[test]
    fn hold_action_on_neutral_blend() {
        let tech = make_tech("SBIN", 50);
        let sentiment = make_sentiment("SBIN", 50);
        let decision = calculate_decision(&tech, Some(&sentiment));

        // 50 * 0.70 + 50 * 0.30 = 35 + 15 = 50
        assert_eq!(decision.final_conviction_score, 50);
        assert_eq!(decision.action_type, ActionType::Hold as i32);
    }

    #[test]
    fn score_clamped_to_valid_range() {
        // Very high scores should clamp to 100
        let tech = make_tech("ITC", 100);
        let sentiment = make_sentiment("ITC", 100);
        let decision = calculate_decision(&tech, Some(&sentiment));

        // 100 * 0.70 + 100 * 0.30 = 100
        assert_eq!(decision.final_conviction_score, 100);
        assert_eq!(decision.action_type, ActionType::Buy as i32);
    }
}
