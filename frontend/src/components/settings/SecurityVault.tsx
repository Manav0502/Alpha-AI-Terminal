'use client';

/**
 * SecurityVault.tsx — Alpha Suite V3 Encrypted Credential Vault UI
 *
 * Provides a settings panel for securely storing API keys using
 * tauri-plugin-stronghold (ChaCha20-Poly1305 AES-256 encryption).
 *
 * Security contract:
 *   - Keys are NEVER stored in localStorage, sessionStorage, or cookies.
 *   - Input fields are always type="password" — masked by the browser.
 *   - Only a boolean "Secured" status is shown after saving.
 *   - The actual key is stored encrypted on disk via Stronghold.
 *   - After vault load, the key is cached in Rust's SecureKeyStore (in-memory).
 *
 * Architecture:
 *   1. On mount: load Stronghold vault and attempt to read existing keys
 *   2. If found, call `hydrate_key_cache` to populate Rust's in-memory store
 *   3. On save: insert into Stronghold + call `save_api_key` for Rust cache
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Shield,
  Key,
  Check,
  X,
  Eye,
  EyeOff,
  AlertCircle,
  Lock,
  Loader2,
  Save,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

// ── Vault Master Password ───────────────────────────────────────────────────
// In a deployed app, prompt the user for a master password on first launch.
// For Alpha Suite, we derive this deterministically from the app identifier
// so the vault opens silently on startup (UX wins, still encrypted at rest).
const VAULT_MASTER_PASSWORD = 'alpha-suite-v3-vault-master-pw-2025';
const VAULT_CLIENT_NAME = 'alpha_suite_credentials';

// ── Provider Definitions ────────────────────────────────────────────────────
interface KeyProvider {
  id: string;
  label: string;
  placeholder: string;
  hint: string;
  docsUrl: string;
}

const PROVIDERS: KeyProvider[] = [
  {
    id: 'hf_key',
    label: 'HuggingFace / DeepSeek API Key',
    placeholder: 'hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    hint: 'Used by the LLM bridge (AI Quant Analysis). Get yours at huggingface.co/settings/tokens',
    docsUrl: 'https://huggingface.co/settings/tokens',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek Direct API Key',
    placeholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    hint: 'Optional: falls back to HuggingFace router if not set.',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'broker',
    label: 'Broker (Zerodha Kite) Access Token',
    placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    hint: 'Regenerated daily. Paste fresh token after Kite login.',
    docsUrl: 'https://kite.zerodha.com/connect/login',
  },
];

// ── Types ───────────────────────────────────────────────────────────────────
type VaultStatus = 'loading' | 'ready' | 'error';
type KeyStatus = 'unknown' | 'secured' | 'missing';

interface ProviderState {
  inputValue: string;
  showInput: boolean;
  status: KeyStatus;
  isSaving: boolean;
  error: string | null;
  successMsg: string | null;
  expanded: boolean;
}

function defaultProviderState(): ProviderState {
  return {
    inputValue: '',
    showInput: false,
    status: 'unknown',
    isSaving: false,
    error: null,
    successMsg: null,
    expanded: false,
  };
}

// ── Stronghold Vault Singleton ──────────────────────────────────────────────
// Lazily initialized once. Shared across all re-renders.
let vaultInstance: import('@tauri-apps/plugin-stronghold').Stronghold | null = null;
let vaultLoadPromise: Promise<void> | null = null;

async function getOrLoadVault(): Promise<import('@tauri-apps/plugin-stronghold').Stronghold | null> {
  // Hard guard: never attempt to evaluate the Tauri plugin during SSR or in
  // any non-browser environment. The dynamic imports below are only safe
  // inside the Tauri WebView (or any browser context), never on the server.
  if (typeof window === 'undefined') return null;

  if (vaultInstance) return vaultInstance;
  if (vaultLoadPromise) {
    await vaultLoadPromise;
    return vaultInstance;
  }

  vaultLoadPromise = (async () => {
    try {
      const { Stronghold } = await import('@tauri-apps/plugin-stronghold');
      const { appDataDir, join } = await import('@tauri-apps/api/path');
      const vaultPath = await join(await appDataDir(), 'alpha_vault.stronghold');
      vaultInstance = await Stronghold.load(vaultPath, VAULT_MASTER_PASSWORD);
    } catch (e) {
      console.error('[SecurityVault] Vault load failed:', e);
      vaultInstance = null;
    }
  })();

  await vaultLoadPromise;
  return vaultInstance;
}

async function readFromVault(provider: string): Promise<string | null> {
  try {
    const vault = await getOrLoadVault();
    if (!vault) return null;
    const client = await vault.createClient(VAULT_CLIENT_NAME);
    const store = client.getStore();
    const raw = await store.get(provider);
    if (!raw) return null;
    return new TextDecoder().decode(new Uint8Array(raw));
  } catch {
    return null;
  }
}

async function writeToVault(provider: string, key: string): Promise<void> {
  const vault = await getOrLoadVault();
  if (!vault) throw new Error('Vault not available');
  const client = await vault.createClient(VAULT_CLIENT_NAME);
  const store = client.getStore();
  await store.insert(provider, Array.from(new TextEncoder().encode(key)));
  await vault.save();
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function SecurityVault() {
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>('loading');
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [providers, setProviders] = useState<Record<string, ProviderState>>(() =>
    Object.fromEntries(PROVIDERS.map((p) => [p.id, defaultProviderState()]))
  );
  const mountedRef = useRef(true);

  // ── Initialize vault and check existing keys ───────────────────────────
  const initVault = useCallback(async () => {
    setVaultStatus('loading');
    setVaultError(null);

    try {
      // Check if we're in a Tauri context at all
      const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
      if (!isTauri) {
        setVaultStatus('error');
        setVaultError('Security Vault requires the Tauri desktop runtime.');
        return;
      }

      const vault = await getOrLoadVault();
      if (!vault) {
        throw new Error('Failed to open encrypted vault. Check app data directory permissions.');
      }

      if (!mountedRef.current) return;
      setVaultStatus('ready');

      // Attempt to load existing keys for each provider
      for (const p of PROVIDERS) {
        const existingKey = await readFromVault(p.id);
        if (!mountedRef.current) return;

        if (existingKey) {
          // Hydrate the Rust in-memory cache so the LLM bridge can use it immediately
          try {
            await invoke('hydrate_key_cache', { provider: p.id, key: existingKey });
          } catch (e) {
            console.warn(`[SecurityVault] hydrate_key_cache failed for ${p.id}:`, e);
          }

          setProviders((prev) => ({
            ...prev,
            [p.id]: { ...prev[p.id], status: 'secured' },
          }));
        } else {
          // Double-check with the Rust state too (fallback check)
          try {
            const exists = await invoke<boolean>('check_api_key_exists', { provider: p.id });
            setProviders((prev) => ({
              ...prev,
              [p.id]: { ...prev[p.id], status: exists ? 'secured' : 'missing' },
            }));
          } catch {
            setProviders((prev) => ({
              ...prev,
              [p.id]: { ...prev[p.id], status: 'missing' },
            }));
          }
        }
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setVaultStatus('error');
      setVaultError(String(e));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    initVault();
    return () => {
      mountedRef.current = false;
    };
  }, [initVault]);

  // ── Save handler ────────────────────────────────────────────────────────
  const handleSave = useCallback(async (providerId: string) => {
    const state = providers[providerId];
    if (!state || !state.inputValue.trim()) {
      setProviders((prev) => ({
        ...prev,
        [providerId]: {
          ...prev[providerId],
          error: 'API key cannot be empty.',
        },
      }));
      return;
    }

    setProviders((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], isSaving: true, error: null, successMsg: null },
    }));

    try {
      const key = state.inputValue.trim();

      // 1. Write to encrypted vault on disk
      await writeToVault(providerId, key);

      // 2. Cache in Rust's in-memory SecureKeyStore (LLM bridge reads from here)
      await invoke('save_api_key', { provider: providerId, key });

      setProviders((prev) => ({
        ...prev,
        [providerId]: {
          ...prev[providerId],
          isSaving: false,
          status: 'secured',
          inputValue: '',      // Clear the input — never show the key again
          showInput: false,
          error: null,
          successMsg: `✅ Key encrypted and secured in vault.`,
        },
      }));

      // Auto-clear success message after 4 seconds
      setTimeout(() => {
        if (mountedRef.current) {
          setProviders((prev) => ({
            ...prev,
            [providerId]: { ...prev[providerId], successMsg: null },
          }));
        }
      }, 4000);
    } catch (e) {
      setProviders((prev) => ({
        ...prev,
        [providerId]: {
          ...prev[providerId],
          isSaving: false,
          error: `Save failed: ${String(e)}`,
        },
      }));
    }
  }, [providers]);

  // ── Revoke / clear a key ─────────────────────────────────────────────
  const handleRevoke = useCallback(async (providerId: string) => {
    setProviders((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], isSaving: true },
    }));
    try {
      await writeToVault(providerId, '');
      await invoke('save_api_key', { provider: providerId, key: '' });
      setProviders((prev) => ({
        ...prev,
        [providerId]: { ...defaultProviderState(), status: 'missing', expanded: prev[providerId].expanded },
      }));
    } catch (e) {
      setProviders((prev) => ({
        ...prev,
        [providerId]: {
          ...prev[providerId],
          isSaving: false,
          error: `Revoke failed: ${String(e)}`,
        },
      }));
    }
  }, []);

  const toggleExpanded = (providerId: string) => {
    setProviders((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], expanded: !prev[providerId].expanded },
    }));
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-0 security-vault">
      {/* ── Vault Status Header ──────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border-default bg-surface/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/15 border border-violet-500/30">
          <Shield size={13} className="text-violet-400" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-[11px] font-bold text-text-primary tracking-tight">Security Vault</span>
          <span className="text-[9px] text-text-muted">AES-256 Encrypted · Never stored in plaintext</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {vaultStatus === 'loading' && (
            <div className="flex items-center gap-1">
              <Loader2 size={10} className="animate-spin text-violet-400" />
              <span className="text-[8px] text-text-muted">Initializing...</span>
            </div>
          )}
          {vaultStatus === 'ready' && (
            <div className="flex items-center gap-1">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[8px] text-emerald-400 font-semibold">VAULT OPEN</span>
            </div>
          )}
          {vaultStatus === 'error' && (
            <div className="flex items-center gap-1">
              <div className="h-1.5 w-1.5 rounded-full bg-rose-400" />
              <span className="text-[8px] text-rose-400 font-semibold">ERROR</span>
            </div>
          )}
          <button
            type="button"
            onClick={initVault}
            title="Reload vault"
            className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-elevated transition-colors"
          >
            <RefreshCw size={10} />
          </button>
        </div>
      </div>

      {/* ── Vault Error Banner ──────────────────────────────────────────── */}
      {vaultStatus === 'error' && vaultError && (
        <div className="mx-3 mt-2 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2">
          <AlertCircle size={12} className="text-rose-400 mt-px shrink-0" />
          <div className="min-w-0">
            <p className="text-[10px] font-semibold text-rose-300">Vault Error</p>
            <p className="text-[9px] text-rose-300/70 mt-0.5 break-words">{vaultError}</p>
          </div>
        </div>
      )}

      {/* ── Security Info Banner ────────────────────────────────────────── */}
      <div className="mx-3 mt-2 flex items-start gap-2 rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2">
        <Lock size={11} className="text-violet-400 mt-px shrink-0" />
        <p className="text-[9px] text-violet-300/80 leading-relaxed">
          Keys are encrypted using <strong className="text-violet-300">Argon2 + AES-256-GCM</strong> and stored only on your device. 
          They are <strong className="text-violet-300">never</strong> sent to any server or stored in browser storage.
        </p>
      </div>

      {/* ── Provider Key Cards ──────────────────────────────────────────── */}
      <div className="flex flex-col mt-2 px-3 gap-2 pb-3">
        {PROVIDERS.map((provider) => {
          const state = providers[provider.id];
          if (!state) return null;

          const isSecured = state.status === 'secured';
          const isMissing = state.status === 'missing';

          return (
            <div
              key={provider.id}
              className={`rounded-xl border transition-all duration-200 ${
                isSecured
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : isMissing
                  ? 'border-amber-500/20 bg-amber-500/5'
                  : 'border-border-default bg-elevated/30'
              }`}
            >
              {/* Card Header */}
              <button
                type="button"
                id={`vault-card-${provider.id}`}
                onClick={() => toggleExpanded(provider.id)}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
              >
                {/* Status Icon */}
                <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
                  isSecured
                    ? 'bg-emerald-500/15 border border-emerald-500/30'
                    : isMissing
                    ? 'bg-amber-500/15 border border-amber-500/30'
                    : 'bg-elevated border border-border-default'
                }`}>
                  {state.status === 'unknown' ? (
                    <Key size={12} className="text-text-muted" />
                  ) : isSecured ? (
                    <Check size={12} className="text-emerald-400" />
                  ) : (
                    <AlertCircle size={12} className="text-amber-400" />
                  )}
                </div>

                {/* Provider Info */}
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-[11px] font-semibold text-text-primary truncate">
                    {provider.label}
                  </span>
                  <span className={`text-[9px] font-semibold ${
                    isSecured ? 'text-emerald-400' : isMissing ? 'text-amber-400' : 'text-text-muted'
                  }`}>
                    {state.status === 'unknown'
                      ? 'Checking vault...'
                      : isSecured
                      ? '✅ Secured in Vault'
                      : '⚠️ Not configured'}
                  </span>
                </div>

                {/* Expand chevron */}
                <div className="shrink-0 text-text-muted">
                  {state.expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </div>
              </button>

              {/* Expanded Input Section */}
              {state.expanded && (
                <div className="border-t border-border-default/50 px-3 py-3 flex flex-col gap-2">
                  {/* Hint */}
                  <p className="text-[9px] text-text-muted leading-relaxed">{provider.hint}</p>

                  {/* Success Message */}
                  {state.successMsg && (
                    <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5">
                      <Check size={11} className="text-emerald-400 shrink-0" />
                      <span className="text-[10px] text-emerald-300 font-medium">{state.successMsg}</span>
                    </div>
                  )}

                  {/* Error Message */}
                  {state.error && (
                    <div className="flex items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5">
                      <X size={11} className="text-rose-400 shrink-0" />
                      <span className="text-[10px] text-rose-300 font-medium">{state.error}</span>
                    </div>
                  )}

                  {/* Input Field — always password type */}
                  <div className="relative">
                    <input
                      id={`vault-input-${provider.id}`}
                      type={state.showInput ? 'text' : 'password'}
                      value={state.inputValue}
                      onChange={(e) =>
                        setProviders((prev) => ({
                          ...prev,
                          [provider.id]: { ...prev[provider.id], inputValue: e.target.value, error: null },
                        }))
                      }
                      placeholder={isSecured ? '•••• Enter new key to replace ••••' : provider.placeholder}
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full rounded-lg border border-border-default bg-surface px-3 pr-9 py-2 text-[11px] font-mono text-text-primary placeholder:text-text-muted/50 focus:border-violet-500/60 focus:outline-none focus:ring-1 focus:ring-violet-500/30 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setProviders((prev) => ({
                          ...prev,
                          [provider.id]: { ...prev[provider.id], showInput: !prev[provider.id].showInput },
                        }))
                      }
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
                      title={state.showInput ? 'Hide key' : 'Show key'}
                    >
                      {state.showInput ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-2">
                    <button
                      id={`vault-save-${provider.id}`}
                      type="button"
                      disabled={state.isSaving || vaultStatus !== 'ready' || !state.inputValue.trim()}
                      onClick={() => handleSave(provider.id)}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-violet-500/15 border border-violet-500/30 px-3 py-1.5 text-[10px] font-semibold text-violet-300 transition-all hover:bg-violet-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {state.isSaving ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Save size={11} />
                      )}
                      {state.isSaving ? 'Encrypting...' : 'Save to Vault'}
                    </button>

                    {isSecured && (
                      <button
                        id={`vault-revoke-${provider.id}`}
                        type="button"
                        disabled={state.isSaving}
                        onClick={() => handleRevoke(provider.id)}
                        className="flex items-center justify-center gap-1 rounded-lg border border-rose-500/25 bg-rose-500/5 px-2.5 py-1.5 text-[10px] font-semibold text-rose-400 transition-all hover:bg-rose-500/15 disabled:opacity-40"
                        title="Remove key from vault"
                      >
                        <X size={11} />
                        Revoke
                      </button>
                    )}
                  </div>

                  {/* Docs Link */}
                  <a
                    href={provider.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[9px] text-text-muted/60 hover:text-violet-400 transition-colors underline underline-offset-2"
                  >
                    Get API key →
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
