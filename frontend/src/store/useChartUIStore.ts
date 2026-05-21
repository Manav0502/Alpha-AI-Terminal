import { create } from 'zustand';

type CursorMode = 'cross' | 'dot' | 'arrow' | 'eraser';
type MagnetMode = 'off' | 'weak' | 'strong';

export type Point = { time: number; price: number };
export type Drawing = { id: string; tool: string; points: Point[]; color?: string; text?: string };

// ── Tauri IPC Bridge ──────────────────────────────────────────────────
// Lazy-import to avoid crashing in browser-only (non-Tauri) dev mode.
// When running `npm run dev` without Tauri, `window.__TAURI__` is undefined.
let tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

async function getInvoke() {
  if (tauriInvoke) return tauriInvoke;
  try {
    // Tauri v2 uses @tauri-apps/api/core
    const mod = await import('@tauri-apps/api/core');
    tauriInvoke = mod.invoke;
    return tauriInvoke;
  } catch {
    // Not running inside Tauri — fall back to no-op
    return null;
  }
}

interface ChartUIState {
  activeCursor: CursorMode;
  activeDrawingTool: string | null;
  magnetMode: MagnetMode;
  drawingsVisible: boolean;
  drawingsLocked: boolean;
  drawings: Drawing[];
  selectedDrawingId: string | null;
  drawingColor: string;

  setActiveCursor: (cursor: CursorMode) => void;
  setActiveDrawingTool: (tool: string | null) => void;
  setMagnetMode: (mode: MagnetMode) => void;
  toggleDrawingsVisible: () => void;
  toggleDrawingsLocked: () => void;
  addDrawing: (drawing: Drawing) => void;
  updateDrawing: (id: string, updates: Partial<Drawing>) => void;
  updateDrawingPoints: (id: string, points: Point[]) => void;
  removeDrawing: (id: string) => void;
  setSelectedDrawing: (id: string | null) => void;
  clearDrawings: () => void;
  setDrawingColor: (color: string) => void;

  // ── Workspace Persistence ──────────────────────────────────────────
  loadWorkspaceFromDB: (symbol: string) => Promise<void>;
  saveWorkspaceToDB: (symbol: string) => Promise<void>;
}

export const useChartUIStore = create<ChartUIState>((set, get) => ({
  activeCursor: 'cross',
  activeDrawingTool: null,
  magnetMode: 'off',
  drawingsVisible: true,
  drawingsLocked: false,
  drawings: [],
  selectedDrawingId: null,
  drawingColor: '#FF5722',

  setActiveCursor: (cursor) => set({ activeCursor: cursor, activeDrawingTool: null }),
  setActiveDrawingTool: (tool) => set({ activeDrawingTool: tool, selectedDrawingId: null }),
  setMagnetMode: (mode) => set({ magnetMode: mode }),
  toggleDrawingsVisible: () => set((state) => ({ drawingsVisible: !state.drawingsVisible })),
  toggleDrawingsLocked: () => set((state) => ({ drawingsLocked: !state.drawingsLocked })),
  addDrawing: (drawing) =>
    set((state) => ({ drawings: [...state.drawings, drawing] })),
  updateDrawing: (id, updates) => set((state) => ({
    drawings: state.drawings.map((d) => (d.id === id ? { ...d, ...updates } : d))
  })),
  updateDrawingPoints: (id, points) =>
    set((state) => ({
      drawings: state.drawings.map((d) => (d.id === id ? { ...d, points } : d)),
    })),
  removeDrawing: (id) =>
    set((state) => ({
      drawings: state.drawings.filter((d) => d.id !== id),
      selectedDrawingId: state.selectedDrawingId === id ? null : state.selectedDrawingId,
    })),
  setSelectedDrawing: (id) => set({ selectedDrawingId: id }),
  clearDrawings: () => set({ drawings: [], selectedDrawingId: null }),
  setDrawingColor: (color) => set({ drawingColor: color }),

  // ── Workspace Persistence Actions ──────────────────────────────────

  /**
   * Load a symbol's persisted workspace from the local SQLite database
   * via Tauri IPC. Hydrates the `drawings` array from the stored JSON.
   * Gracefully no-ops when running outside of Tauri (browser-only dev).
   */
  loadWorkspaceFromDB: async (symbol: string) => {
    try {
      const invoke = await getInvoke();
      if (!invoke) return; // Not running in Tauri

      const raw = (await invoke('load_workspace', { symbol })) as string;
      if (!raw || raw === '{}') {
        // No saved workspace — start with a blank canvas
        set({ drawings: [], selectedDrawingId: null });
        return;
      }

      const parsed = JSON.parse(raw);
      const drawings: Drawing[] = Array.isArray(parsed.drawings) ? parsed.drawings : [];
      set({ drawings, selectedDrawingId: null });
      console.log(`[Workspace] Loaded ${drawings.length} drawings for ${symbol}`);
    } catch (err) {
      console.warn(`[Workspace] Failed to load workspace for ${symbol}:`, err);
      // Don't wipe existing drawings on load failure
    }
  },

  /**
   * Persist the current drawings to the local SQLite database via
   * Tauri IPC. Serializes the full drawings array as a JSON blob.
   * Gracefully no-ops when running outside of Tauri (browser-only dev).
   */
  saveWorkspaceToDB: async (symbol: string) => {
    try {
      const invoke = await getInvoke();
      if (!invoke) return; // Not running in Tauri

      const { drawings } = get();
      const stateJson = JSON.stringify({ drawings });
      await invoke('save_workspace', { symbol, stateJson });
      console.log(`[Workspace] Saved ${drawings.length} drawings for ${symbol}`);
    } catch (err) {
      console.warn(`[Workspace] Failed to save workspace for ${symbol}:`, err);
    }
  },
}));
