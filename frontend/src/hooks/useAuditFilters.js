/**
 * useAuditFilters
 *
 * Centralises all audit-log filter state with:
 *  - URL serialisation   — reloading a filtered URL restores the same query
 *  - Validation          — unknown / invalid query values are silently ignored
 *  - Date normalisation  — endDate is expanded to 23:59:59.999 in apiParams
 *  - Pagination reset    — every filter change resets the cursor stack
 *  - Debounce            — free-text fields (actorId, search) wait 350 ms
 *  - Clear-all           — one call wipes all filters and pagination
 *
 * @returns {{
 *   filters:   AuditFilters,
 *   setFilter: (key: string, value: string) => void,
 *   clearAll:  () => void,
 *   apiParams: object,
 * }}
 *
 * AuditFilters shape:
 *  { action, targetType, result, actorId, search, startDate, endDate }
 *
 * All values are strings; an empty string means "no filter".
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/router";

// ─── Constants ─────────────────────────────────────────────────────────────

/** Debounce delay in ms for free-text fields. */
const DEBOUNCE_MS = 350;

/** Blank filter state. */
const EMPTY_FILTERS = {
  action:     "",
  targetType: "",
  result:     "",
  actorId:    "",
  search:     "",
  startDate:  "",
  endDate:    "",
};

/**
 * Valid values for enum-typed filters.
 * An empty string always means "no filter" and is always accepted.
 */
const VALID_ACTIONS = new Set([
  "student_create",
  "student_update",
  "student_delete",
  "student_bulk_import",
  "payment_manual_sync",
  "payment_finalize",
  "fee_create",
  "fee_update",
  "fee_delete",
  "school_create",
  "school_update",
  "school_deactivate",
]);

const VALID_TARGET_TYPES = new Set(["student", "payment", "fee", "school"]);
const VALID_RESULTS      = new Set(["success", "failure"]);

/**
 * ISO 8601 date-only pattern (YYYY-MM-DD).
 * Used to validate startDate / endDate before writing to state.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Validation helpers ─────────────────────────────────────────────────────

/**
 * Validate a single filter key/value pair.
 * Returns the sanitised string value, or "" if the value is invalid.
 *
 * @param {string} key
 * @param {string} raw
 * @returns {string}
 */
function validate(key, raw) {
  if (raw === "" || raw === undefined || raw === null) return "";
  const v = String(raw).trim();
  switch (key) {
    case "action":
      return VALID_ACTIONS.has(v) ? v : "";
    case "targetType":
      return VALID_TARGET_TYPES.has(v) ? v : "";
    case "result":
      return VALID_RESULTS.has(v) ? v : "";
    case "startDate":
    case "endDate":
      return DATE_RE.test(v) ? v : "";
    case "actorId":
    case "search":
      // Free-text: accept any non-empty string (trimmed).
      return v;
    default:
      return "";
  }
}

/**
 * Parse the Next.js router.query object into a validated AuditFilters object.
 * Any query key that is not a recognised filter key is ignored.
 *
 * @param {object} query  — router.query
 * @returns {AuditFilters}
 */
function parseQuery(query) {
  const filters = { ...EMPTY_FILTERS };
  for (const key of Object.keys(EMPTY_FILTERS)) {
    // next/router may expose array values (repeated params); use first element.
    const raw = Array.isArray(query[key]) ? query[key][0] : query[key];
    filters[key] = validate(key, raw || "");
  }
  return filters;
}

/**
 * Build the URL query string object from current filter state.
 * Only non-empty values are serialised (keeps URLs clean).
 *
 * @param {AuditFilters} filters
 * @returns {object}
 */
function toQuery(filters) {
  const q = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v) q[k] = v;
  }
  return q;
}

/**
 * Build the params object ready to pass to getAuditLogs().
 *
 *  - actorId → performedBy (API param name)
 *  - endDate is expanded to 23:59:59.999 UTC for the local calendar day
 *
 * @param {AuditFilters} filters
 * @param {object}       debounced  — { actorId, search } after debounce
 * @returns {object}
 */
function toApiParams(filters, debounced) {
  const p = { limit: 50 };
  if (filters.action)        p.action     = filters.action;
  if (filters.targetType)    p.targetType = filters.targetType;
  if (filters.result)        p.result     = filters.result;
  if (debounced.actorId)     p.performedBy = debounced.actorId;
  if (debounced.search)      p.search     = debounced.search;
  if (filters.startDate) {
    p.startDate = new Date(filters.startDate).toISOString();
  }
  if (filters.endDate) {
    const end = new Date(filters.endDate);
    end.setHours(23, 59, 59, 999);
    p.endDate = end.toISOString();
  }
  return p;
}

// ─── Exported helpers (used by tests) ──────────────────────────────────────
// These pure functions contain all the business logic that acceptance tests
// exercise directly without needing a React renderer.
export { validate, parseQuery, toQuery, toApiParams };

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useAuditFilters() {
  const router = useRouter();

  // ── Initialise from URL query on first render ──────────────────────────
  // router.query is {} on SSR and populated on the client.  We initialise
  // once from the query and ignore subsequent query changes (the hook owns
  // the source of truth after mount).
  const initialisedRef = useRef(false);
  const historyModeRef = useRef("replace");
  const [filters, setFiltersRaw] = useState(EMPTY_FILTERS);

  // Initialise from URL on first time router.query is populated.
  // router.isReady guards against consuming an empty query on SSR.
  useEffect(() => {
    if (!initialisedRef.current && router.isReady) {
      initialisedRef.current = true;
      historyModeRef.current = "replace";
      setFiltersRaw(parseQuery(router.query));
    }
  }, [router.isReady, router.query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const syncFromUrl = () => {
      const nextFilters = parseQuery(router.query);
      historyModeRef.current = "replace";
      setFiltersRaw((current) => (
        Object.keys(EMPTY_FILTERS).every((key) => current[key] === nextFilters[key])
          ? current
          : nextFilters
      ));
      setPaginationResetCount((count) => count + 1);
    };
    router.events.on("routeChangeComplete", syncFromUrl);
    return () => router.events.off("routeChangeComplete", syncFromUrl);
  }, [router]);

  // ── Debounced text values ───────────────────────────────────────────────
  const [debouncedActorId, setDebouncedActorId] = useState("");
  const [debouncedSearch,  setDebouncedSearch]  = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedActorId(filters.actorId), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [filters.actorId]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(filters.search), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [filters.search]);

  // ── Pagination reset counter ────────────────────────────────────────────
  // Incrementing this is how callers know all filters changed and pagination
  // must restart from the first page.
  const [paginationResetCount, setPaginationResetCount] = useState(0);

  // ── URL sync ────────────────────────────────────────────────────────────
  // Keep the URL in sync whenever filters change (after initialisation).
  // Discrete filters create history entries; text edits replace the current
  // entry so typing does not flood the browser history.
  const syncUrlRef = useRef(false); // avoid syncing back on the initial read
  useEffect(() => {
    if (!initialisedRef.current) return; // not yet initialised from URL
    if (!syncUrlRef.current) {
      // Skip the very first effect run that fires right after initialisation.
      syncUrlRef.current = true;
      return;
    }
    const method = historyModeRef.current;
    historyModeRef.current = "replace";
    router[method](
      { pathname: router.pathname, query: toQuery(filters) },
      undefined,
      { shallow: true, scroll: false }
    );
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── setFilter ───────────────────────────────────────────────────────────
  /**
   * Update a single filter key.  The value is validated before being stored;
   * an invalid value is silently coerced to "".  Resets pagination.
   *
   * @param {string} key   — one of the AuditFilters keys
   * @param {string} value — raw user input
   */
  const setFilter = useCallback((key, value) => {
    const sanitised = validate(key, value);
    historyModeRef.current = key === "actorId" || key === "search" ? "replace" : "push";
    setFiltersRaw((prev) => {
      if (prev[key] === sanitised) {
        historyModeRef.current = "replace";
        return prev;
      }
      return { ...prev, [key]: sanitised };
    });
    setPaginationResetCount((n) => n + 1);
  }, []);

  // ── clearAll ────────────────────────────────────────────────────────────
  /**
   * Reset all filters to empty and increment the pagination-reset counter.
   */
  const clearAll = useCallback(() => {
    historyModeRef.current = "push";
    setFiltersRaw(EMPTY_FILTERS);
    setPaginationResetCount((n) => n + 1);
  }, []);

  // ── Derived apiParams ───────────────────────────────────────────────────
  const apiParams = toApiParams(filters, {
    actorId: debouncedActorId,
    search:  debouncedSearch,
  });

  return {
    /** Current filter values (display / controlled-input values). */
    filters,
    /** Update a single filter; resets pagination. */
    setFilter,
    /** Clear every filter and reset pagination. */
    clearAll,
    /**
     * Ready-to-send params for getAuditLogs().
     * Text filters use debounced values; endDate is normalised to 23:59:59.999.
     */
    apiParams,
    /**
     * Incremented every time a filter changes or clearAll is called.
     * Watch this in the page to reset cursorStack / trigger a fresh fetch.
     */
    paginationResetCount,
  };
}
