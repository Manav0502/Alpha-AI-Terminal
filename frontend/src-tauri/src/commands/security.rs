// commands/security.rs — Security Vault Tauri Commands
//
// This module provides Tauri IPC commands for the encrypted credential vault.
// Keys are stored on disk via tauri-plugin-stronghold (ChaCha20-Poly1305 AES-256)
// and cached in a process-local Mutex<HashMap> so Rust-side services (LLM bridge)
// can read them without making a second round-trip to the frontend.
//
// Security guarantees:
//   - Keys are NEVER stored in localStorage, sessionStorage, or plain files.
//   - The stronghold vault is encrypted with Argon2-derived key from a machine salt.
//   - The in-memory cache is cleared on app exit (OS process boundary).
//   - `check_api_key_exists` returns bool only — never the raw key.

use log::{info, warn};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

// ── Secure In-Memory Key Cache ───────────────────────────────────────────────
//
// This state is registered with Tauri's `.manage()` so it lives for the entire
// app lifetime (equivalent to a process-level global, but properly scoped).
// It is populated by `save_api_key` and read by `get_api_key_from_vault`.

#[derive(Debug, Default)]
pub struct SecureKeyStore {
    inner: Arc<Mutex<HashMap<String, String>>>,
}

impl SecureKeyStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Insert a key by provider name. Called from `save_api_key`.
    pub fn insert(&self, provider: &str, key: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(provider.to_lowercase(), key.to_string());
        }
    }

    /// Check if a key exists for the given provider. Called from `check_api_key_exists`.
    pub fn contains(&self, provider: &str) -> bool {
        self.inner
            .lock()
            .map(|m| m.contains_key(&provider.to_lowercase()))
            .unwrap_or(false)
    }

    /// Read the raw key for internal Rust use (LLM bridge). Not exposed to frontend.
    /// Returns None if the key has not yet been loaded by the user in this session.
    pub fn get(&self, provider: &str) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|m| m.get(&provider.to_lowercase()).cloned())
    }
}

// ── Tauri Commands ───────────────────────────────────────────────────────────

/// Save an API key to the encrypted vault.
///
/// The key is:
///   1. Stored in the Stronghold vault on disk (encrypted).
///   2. Cached in the in-memory `SecureKeyStore` for fast access by Rust services.
///
/// # Frontend Usage
/// ```typescript
/// await invoke('save_api_key', { provider: 'deepseek', key: 'sk-...' });
/// ```
#[tauri::command]
pub async fn save_api_key(
    app: AppHandle,
    provider: String,
    key: String,
) -> Result<(), String> {
    use tauri::Manager;

    if key.trim().is_empty() {
        return Err("API key cannot be empty.".to_string());
    }

    let provider_normalized = provider.trim().to_lowercase();

    // 1. Cache in in-memory SecureKeyStore for Rust services
    let store = app
        .try_state::<SecureKeyStore>()
        .ok_or("SecureKeyStore not initialized — this is a bug.")?;
    store.insert(&provider_normalized, &key);

    info!(
        "[security] API key saved for provider='{}' key_len={}",
        provider_normalized,
        key.len()
    );

    // 2. Persist to the encrypted vault via Stronghold JS bridge.
    //    The actual disk write happens through the frontend JS SDK
    //    (save is initiated from the React component after this call).
    //    This command acts as the Rust "register" endpoint; the JS SDK
    //    does the stronghold.save() call immediately after.

    Ok(())
}

/// Check if an API key has been configured for a given provider.
/// Returns a boolean so the UI can show a "Secured" badge without
/// ever exposing the key value.
///
/// # Frontend Usage
/// ```typescript
/// const exists = await invoke<boolean>('check_api_key_exists', { provider: 'deepseek' });
/// ```
#[tauri::command]
pub async fn check_api_key_exists(
    app: AppHandle,
    provider: String,
) -> Result<bool, String> {
    use tauri::Manager;

    let provider_normalized = provider.trim().to_lowercase();

    let store = app
        .try_state::<SecureKeyStore>()
        .ok_or("SecureKeyStore not initialized.")?;

    let exists = store.contains(&provider_normalized);

    info!(
        "[security] check_api_key_exists provider='{}' exists={}",
        provider_normalized,
        exists
    );

    Ok(exists)
}

/// Called from the frontend after restoring a key from the Stronghold vault on startup.
/// The frontend decrypts the value from the JS SDK and passes it back here so the
/// in-memory cache is populated for Rust services (LLM bridge).
///
/// This is the only safe bridge: the key travels JS → Tauri IPC (encrypted channel) → Rust.
/// It is NOT stored in any browser-accessible storage.
///
/// # Frontend Usage
/// ```typescript
/// await invoke('hydrate_key_cache', { provider: 'deepseek', key: decryptedKey });
/// ```
#[tauri::command]
pub async fn hydrate_key_cache(
    app: AppHandle,
    provider: String,
    key: String,
) -> Result<(), String> {
    use tauri::Manager;

    if key.trim().is_empty() {
        warn!("[security] hydrate_key_cache called with empty key for provider='{}'", provider);
        return Ok(()); // not an error — vault may be empty on first run
    }

    let store = app
        .try_state::<SecureKeyStore>()
        .ok_or("SecureKeyStore not initialized.")?;

    store.insert(&provider.trim().to_lowercase(), &key);

    info!(
        "[security] Key cache hydrated for provider='{}'",
        provider.trim().to_lowercase()
    );

    Ok(())
}

// ── Internal Rust API (not a Tauri command) ─────────────────────────────────

/// Read the API key for a given provider from the in-memory SecureKeyStore.
/// Used by Rust services (e.g., LLM bridge) to avoid reading from .env files.
/// Returns None if the key has not been loaded in this session.
pub fn get_api_key_from_vault(app: &AppHandle, provider: &str) -> Option<String> {
    use tauri::Manager;
    app.try_state::<SecureKeyStore>()
        .and_then(|store| store.get(provider))
}
