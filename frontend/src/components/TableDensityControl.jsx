/**
 * TableDensityControl — Issue #113
 *
 * Provides density options (compact / default / comfortable) for data tables.
 * Density persists in localStorage so users don't need to re-select on every visit.
 *
 * Usage:
 *   import { useTableDensity, TableDensityControl } from './TableDensityControl';
 *
 *   const { density } = useTableDensity();
 *   <div data-density={density}>
 *     <TableDensityControl />
 *     <table className="data-table"> ... </table>
 *   </div>
 */
import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";

export const DENSITY_OPTIONS = ["compact", "default", "comfortable"];
const STORAGE_KEY = "tableDensity";
const DEFAULT_DENSITY = "default";

/**
 * Hook that reads/writes the user's preferred table density.
 * @returns {{ density: string, setDensity: (d: string) => void }}
 */
export function useTableDensity() {
  const [density, setDensityState] = useState(DEFAULT_DENSITY);

  // Hydrate from localStorage on mount (client-only).
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && DENSITY_OPTIONS.includes(stored)) {
        setDensityState(stored);
      }
    } catch {
      // localStorage unavailable (SSR / private browsing) — use default.
    }
  }, []);

  const setDensity = useCallback((d) => {
    if (!DENSITY_OPTIONS.includes(d)) return;
    setDensityState(d);
    try {
      localStorage.setItem(STORAGE_KEY, d);
    } catch {
      // Ignore write errors.
    }
  }, []);

  return { density, setDensity };
}

/**
 * Renders three density-toggle buttons.
 * Must be used inside a component that also calls useTableDensity().
 *
 * @param {{ density: string, setDensity: function, size?: number }} props
 */
export function TableDensityControl({ density, setDensity, size = 13 }) {
  const { t } = useTranslation();

  const options = [
    {
      value: "compact",
      label: t("dashboard.densityCompact"),
      // Three tight horizontal bars
      icon: (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1" y="2"  width="14" height="2" rx="1" fill="currentColor" />
          <rect x="1" y="7"  width="14" height="2" rx="1" fill="currentColor" />
          <rect x="1" y="12" width="14" height="2" rx="1" fill="currentColor" />
        </svg>
      ),
    },
    {
      value: "default",
      label: t("dashboard.densityDefault"),
      // Three medium-spaced bars
      icon: (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1" y="1"  width="14" height="3" rx="1" fill="currentColor" />
          <rect x="1" y="6.5" width="14" height="3" rx="1" fill="currentColor" />
          <rect x="1" y="12" width="14" height="3" rx="1" fill="currentColor" />
        </svg>
      ),
    },
    {
      value: "comfortable",
      label: t("dashboard.densityComfortable"),
      // Two wide bars
      icon: (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="14" height="5" rx="1" fill="currentColor" />
          <rect x="1" y="10" width="14" height="5" rx="1" fill="currentColor" />
        </svg>
      ),
    },
  ];

  return (
    <div
      role="group"
      aria-label={t("dashboard.densityLabel")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "2px",
        border: "1.5px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        padding: "2px",
        background: "var(--card-bg)",
      }}
    >
      {options.map((opt) => {
        const active = density === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setDensity(opt.value)}
            aria-pressed={active}
            aria-label={opt.label}
            title={opt.label}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 26,
              border: "none",
              borderRadius: "calc(var(--radius-sm) - 2px)",
              cursor: "pointer",
              background: active ? "var(--accent-subtle)" : "transparent",
              color: active ? "var(--accent)" : "var(--text-muted)",
              transition: "background 0.15s, color 0.15s",
            }}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.background = "var(--bg-subtle, var(--bg))";
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.background = "transparent";
            }}
          >
            {opt.icon}
          </button>
        );
      })}
    </div>
  );
}
