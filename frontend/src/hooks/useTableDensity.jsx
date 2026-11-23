import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * TableDensityContext — #361
 *
 * Provides a global (or per-table) row-density preference that persists
 * in localStorage. Three density levels are defined:
 *
 *   compact     — 28 px row height  (dense data)
 *   default     — 40 px row height  (standard)
 *   comfortable — 52 px row height  (relaxed reading)
 *
 * Usage:
 *   const { density, setDensity, rowHeight, cellPadding } = useTableDensity();
 *
 * Per-table overrides:
 *   Use the `tableId` parameter in useTableDensity to maintain an independent
 *   preference for a specific table, e.g.:
 *
 *     const { density, setDensity } = useTableDensity("payments-table");
 *
 *   If no tableId is given the global preference is used.
 */
export const TableDensityContext = createContext(null);

export const DENSITY_LEVELS = {
  compact: {
    id:          "compact",
    label:       "Compact",
    rowHeight:   28,
    cellPadding: "0 0.625rem",
    fontSize:    "0.8rem",
    description: "More rows visible at once. Best for power users reviewing large datasets.",
  },
  default: {
    id:          "default",
    label:       "Default",
    rowHeight:   40,
    cellPadding: "0 0.75rem",
    fontSize:    "0.875rem",
    description: "Balanced readability and density. Suitable for most tasks.",
  },
  comfortable: {
    id:          "comfortable",
    label:       "Comfortable",
    rowHeight:   52,
    cellPadding: "0 0.875rem",
    fontSize:    "0.9rem",
    description: "More breathing room between rows. Ideal for careful review.",
  },
};

const STORAGE_KEY_GLOBAL = "tableDensity_global";
const STORAGE_KEY_PREFIX  = "tableDensity_";
const DEFAULT_DENSITY      = "default";

function readStoredDensity(key) {
  try {
    const val = localStorage.getItem(key);
    return DENSITY_LEVELS[val] ? val : null;
  } catch {
    return null;
  }
}

function writeStoredDensity(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage unavailable — degrade gracefully */ }
}

/**
 * TableDensityProvider
 *
 * Wrap the app (or a subtree) with this provider. The global preference is
 * automatically hydrated from localStorage on first render.
 */
export function TableDensityProvider({ children }) {
  // Global preference — shared across all tables that don't supply a tableId
  const [globalDensity, setGlobalDensityState] = useState(DEFAULT_DENSITY);

  // Per-table overrides  { [tableId]: densityId }
  const [tableOverrides, setTableOverrides] = useState({});

  // Hydrate from localStorage on mount (SSR-safe)
  useEffect(() => {
    const stored = readStoredDensity(STORAGE_KEY_GLOBAL);
    if (stored) setGlobalDensityState(stored);

    // Hydrate any per-table overrides that were saved
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(STORAGE_KEY_PREFIX) && key !== STORAGE_KEY_GLOBAL) {
          const tableId = key.slice(STORAGE_KEY_PREFIX.length);
          const val = readStoredDensity(key);
          if (val) {
            setTableOverrides((prev) => ({ ...prev, [tableId]: val }));
          }
        }
      }
    } catch { /* ignore */ }
  }, []);

  const setGlobalDensity = useCallback((density) => {
    if (!DENSITY_LEVELS[density]) return;
    setGlobalDensityState(density);
    writeStoredDensity(STORAGE_KEY_GLOBAL, density);
  }, []);

  const setTableDensity = useCallback((tableId, density) => {
    if (!DENSITY_LEVELS[density]) return;
    setTableOverrides((prev) => ({ ...prev, [tableId]: density }));
    writeStoredDensity(`${STORAGE_KEY_PREFIX}${tableId}`, density);
  }, []);

  const getDensityFor = useCallback(
    (tableId) => tableId && tableOverrides[tableId] ? tableOverrides[tableId] : globalDensity,
    [globalDensity, tableOverrides]
  );

  return (
    <TableDensityContext.Provider
      value={{
        globalDensity,
        setGlobalDensity,
        tableOverrides,
        setTableDensity,
        getDensityFor,
        levels: DENSITY_LEVELS,
      }}
    >
      {children}
    </TableDensityContext.Provider>
  );
}

/**
 * useTableDensity
 *
 * Returns density metadata for a given table (or the global preference if no
 * tableId is supplied). Provides a convenient `setDensity` that automatically
 * targets the right scope.
 *
 * @param {string} [tableId] — optional per-table scope identifier
 */
export function useTableDensity(tableId) {
  const ctx = useContext(TableDensityContext);
  if (!ctx) {
    throw new Error("useTableDensity must be used inside <TableDensityProvider>");
  }

  const densityId = ctx.getDensityFor(tableId);
  const level     = DENSITY_LEVELS[densityId] || DENSITY_LEVELS[DEFAULT_DENSITY];

  const setDensity = useCallback(
    (d) => (tableId ? ctx.setTableDensity(tableId, d) : ctx.setGlobalDensity(d)),
    [ctx, tableId]
  );

  return {
    density:     densityId,
    setDensity,
    rowHeight:   level.rowHeight,
    cellPadding: level.cellPadding,
    fontSize:    level.fontSize,
    level,
  };
}
