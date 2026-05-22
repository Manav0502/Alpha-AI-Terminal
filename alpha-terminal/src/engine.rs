use std::collections::HashMap;
use crate::proto::market_data::{OhlcCandle, Tick};

pub struct SymbolState {
    pub active_candle: OhlcCandle,
    pub prev_cumulative_volume: u64,
}

pub struct OhlcEngine {
    states: HashMap<String, SymbolState>,
}

impl OhlcEngine {
    pub fn new() -> Self {
        Self {
            states: HashMap::new(),
        }
    }

    pub fn process_tick(&mut self, tick: &Tick) -> Option<OhlcCandle> {
        let window_start_ms = (tick.timestamp_ms as u64 / 600_000) * 600_000;
        let current_cumulative_volume = tick.volume.max(0) as u64;

        if !self.states.contains_key(&tick.symbol) {
            let volume_delta = current_cumulative_volume; // First tick seen
            
            self.states.insert(tick.symbol.clone(), SymbolState {
                active_candle: OhlcCandle {
                    symbol: tick.symbol.clone(),
                    start_timestamp_ms: window_start_ms,
                    end_timestamp_ms: window_start_ms + 600_000,
                    open: tick.last_traded_price,
                    high: tick.last_traded_price,
                    low: tick.last_traded_price,
                    close: tick.last_traded_price,
                    volume: volume_delta,
                },
                prev_cumulative_volume: current_cumulative_volume,
            });
            return None;
        }

        let state = self.states.get_mut(&tick.symbol).unwrap();
        let volume_delta = current_cumulative_volume.saturating_sub(state.prev_cumulative_volume);
        state.prev_cumulative_volume = current_cumulative_volume;

        if window_start_ms == state.active_candle.start_timestamp_ms {
            state.active_candle.high = state.active_candle.high.max(tick.last_traded_price);
            state.active_candle.low = state.active_candle.low.min(tick.last_traded_price);
            state.active_candle.close = tick.last_traded_price;
            state.active_candle.volume += volume_delta;
            None
        } else if window_start_ms > state.active_candle.start_timestamp_ms {
            let completed_candle = state.active_candle.clone();
            
            state.active_candle = OhlcCandle {
                symbol: tick.symbol.clone(),
                start_timestamp_ms: window_start_ms,
                end_timestamp_ms: window_start_ms + 600_000,
                open: tick.last_traded_price,
                high: tick.last_traded_price,
                low: tick.last_traded_price,
                close: tick.last_traded_price,
                volume: volume_delta,
            };
            Some(completed_candle)
        } else {
            // Late tick
            None
        }
    }

    /// Returns a clone of the in-progress candle for a given symbol.
    /// Used to stream live candle updates to the frontend on every tick,
    /// not just when a 10-minute window closes.
    pub fn get_active_candle(&self, symbol: &str) -> Option<OhlcCandle> {
        self.states.get(symbol).map(|s| s.active_candle.clone())
    }
}
