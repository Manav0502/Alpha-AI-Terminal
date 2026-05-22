// state.rs — Aggregator-level shared state for dynamic weighting.
//
// Master Phase 1 → Power Phase 1.5 → Subphase 40.
//
// Caches the most recent `NewsSentiment` for each symbol so that when a
// `TechSignal` arrives the decision engine can immediately look up the
// latest sentiment context without re-querying Kafka.
//
// Thread safety:
//   - `RwLock` allows many concurrent readers (TechSignal processing)
//     while only blocking when a new sentiment is written.
//   - `Arc` enables cheap cloning into multiple async tasks.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::proto::sentiment_data::NewsSentiment;

/// Central aggregator state — stores the latest sentiment per symbol.
///
/// # Usage
/// ```ignore
/// let state = AggregatorState::new();
///
/// // Writer (sentiment consumer):
/// state.update_sentiment("RELIANCE".into(), sentiment).await;
///
/// // Reader (tech signal consumer):
/// let latest = state.get_sentiment("RELIANCE").await;
/// ```
pub struct AggregatorState {
    /// Maps `symbol → latest NewsSentiment` for that symbol.
    /// Wrapped in `RwLock` for concurrent read access with exclusive writes.
    /// Only active when the `kafka` feature is enabled (consumer loop wires it up).
    #[cfg_attr(not(feature = "kafka"), allow(dead_code))]
    sentiments: Arc<RwLock<HashMap<String, NewsSentiment>>>,
}

impl AggregatorState {
    /// Creates a new, empty aggregator state.
    pub fn new() -> Self {
        Self {
            sentiments: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Inserts or updates the cached sentiment for a given symbol.
    ///
    /// Called when a `NewsSentiment` message arrives from Kafka.
    /// Acquires a write lock — blocks concurrent readers momentarily.
    #[cfg(feature = "kafka")]
    pub async fn update_sentiment(&self, symbol: String, sentiment: NewsSentiment) {
        let mut guard = self.sentiments.write().await;
        guard.insert(symbol, sentiment);
    }

    /// Retrieves a clone of the latest cached sentiment for a symbol, if any.
    ///
    /// Called when a `TechSignal` arrives and the engine needs sentiment context.
    /// Acquires a read lock — does NOT block other readers.
    #[cfg(feature = "kafka")]
    pub async fn get_sentiment(&self, symbol: &str) -> Option<NewsSentiment> {
        let guard = self.sentiments.read().await;
        guard.get(symbol).cloned()
    }
}
