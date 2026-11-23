import { useState, useEffect, useRef } from "react";
import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import TestnetBanner from "./TestnetBanner";
import NotificationCenter from "./NotificationCenter";
import { useTheme } from "../pages/_app";
import { useAdminAuthContext } from "../hooks/AdminAuthContext";
import { prefetchDashboardData } from "../hooks/useDashboardLoader";
import { SUPPORTED_LOCALES, LOCALE_NAMES } from "../i18n";

/**
 * Navigation link definitions — Issue #357: role-aware navigation.
 *
 * requiredRole: "public"  — visible to everyone
 * requiredRole: "admin"   — hidden from non-admin users entirely
 * locked: true            — visible to all but greyed out with a lock icon + tooltip
 *                           (represents upgrade-required or coming-soon features)
 */
const NAV_LINKS = [
  { href: "/pay-fees",              i18nKey: "nav.payFees",         requiredRole: "public" },
  { href: "/dashboard",             i18nKey: "nav.dashboard",       requiredRole: "public" },
  { href: "/reports",               i18nKey: "nav.reports",         requiredRole: "public" },
  { href: "/fee-adjustments",       i18nKey: "nav.feeRules",        requiredRole: "admin"  },
  { href: "/audit-logs",            i18nKey: "nav.auditLogs",       requiredRole: "admin"  },
  { href: "/disputes",              i18nKey: "nav.disputes",        requiredRole: "admin"  },
  { href: "/webhooks",              i18nKey: "nav.webhooks",        requiredRole: "admin"  },
];

const ADMIN_LINKS = [
  { href: "/fee-adjustments", i18nKey: "nav.feeRules" },
  { href: "/audit-logs",      i18nKey: "nav.auditLogs" },
  { href: "/disputes",        i18nKey: "nav.disputes" },
  { href: "/webhooks",        i18nKey: "nav.webhooks" },
  { href: "/retention",       i18nKey: "nav.retention" },
];

// Focusable elements we allow inside the mobile menu trap
const FOCUSABLE_SELECTORS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const SunIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="5"/>
    <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
    <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
  </svg>
);

const MoonIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>
);

/** Padlock icon — rendered next to locked (upgrade-required) nav items. */
const LockIcon = () => (
  <svg
    width="10" height="10"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flexShrink: 0 }}
  >
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
);

/**
 * NavLink — renders a single navigation link, with role-aware visibility.
 * - If `locked` is true: renders a disabled link with a lock icon + tooltip.
 * - Otherwise: renders a normal Next.js Link.
 */
function NavLink({ href, label, active, locked = false, lockedTooltip, mobile = false }) {
  const baseStyle = {
    color: locked ? "rgba(255,255,255,0.25)" : undefined,
    cursor: locked ? "default" : undefined,
    pointerEvents: locked ? "none" : undefined,
    position: "relative",
  };

  if (locked) {
    return (
      <span
        className={`nav-link${mobile ? "" : ""}`}
        style={{
          ...baseStyle,
          display: "inline-flex",
          alignItems: "center",
          gap: "0.25rem",
        }}
        title={lockedTooltip || "Requires upgrade"}
        aria-label={`${label} — ${lockedTooltip || "Requires upgrade"}`}
        role="presentation"
      >
        {label}
        <LockIcon />
      </span>
    );
  }

  return (
    <Link
      href={href}
      className={`nav-link${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
      style={mobile ? undefined : undefined}
    >
      {label}
    </Link>
  );
}

export default function Navbar() {
  const { pathname } = useRouter();
  const [open, setOpen] = useState(false);
  const { t, i18n } = useTranslation();
  const { dark, toggle } = useTheme();
  const { isAdmin, logout } = useAdminAuthContext();

  /**
   * Issue #357 — Role-aware navigation.
   *
   * Filter the master NAV_LINKS list based on the current user's role:
   *  - "public" links: always shown
   *  - "admin" links: shown only when isAdmin is true; hidden entirely otherwise
   *  - locked links: shown to everyone with a lock icon (not applicable here yet)
   *
   * This prevents non-admin users from seeing admin-only nav items and being
   * redirected to a 403 page when they click them.
   */
  const visibleLinks = NAV_LINKS.filter((link) => {
    if (link.requiredRole === "admin") return isAdmin;
    return true; // "public" and any future "locked" links are always included
  });

  const hamburgerRef = useRef(null);
  const mobileMenuRef = useRef(null);

  // Close menu on route change
  useEffect(() => { setOpen(false); }, [pathname]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        hamburgerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Focus trap: keep Tab/Shift+Tab inside the open mobile menu
  useEffect(() => {
    if (!open || !mobileMenuRef.current) return;

    const menu = mobileMenuRef.current;
    const getFocusable = () =>
      Array.from(menu.querySelectorAll(FOCUSABLE_SELECTORS)).filter(
        (el) => !el.closest("[aria-hidden='true']")
      );

    const handleTrap = (e) => {
      if (e.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    menu.addEventListener("keydown", handleTrap);
    // Move focus into the menu when it opens
    const focusable = getFocusable();
    if (focusable.length > 0) focusable[0].focus();

    return () => menu.removeEventListener("keydown", handleTrap);
  }, [open]);

  // Prevent body scroll while menu is open
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    hamburgerRef.current?.focus();
  }, []);

  return (
    <>
      <style>{`
        .nav {
          background: #0e1424;
          background-image: radial-gradient(600px 120px at 18% 0%, rgba(16,185,129,0.20), transparent 70%);
          border-bottom: 1px solid rgba(255, 255, 255, 0.07);
          position: sticky;
          top: 0;
          z-index: 200;
          backdrop-filter: saturate(140%);
          /* Prevent the navbar itself from scrolling horizontally */
          overflow: hidden;
        }
        .nav-inner {
          max-width: 1280px;
          margin: 0 auto;
          padding: 0 1.5rem;
          height: 60px;
          display: flex;
          align-items: center;
          gap: 1.5rem;
        }
        .nav-brand {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          text-decoration: none;
          flex-shrink: 0;
          margin-right: 0.5rem;
        }
        .nav-logo {
          width: 32px; height: 32px;
          background: linear-gradient(135deg, #34d399 0%, #059669 55%, #0d9488 100%);
          border-radius: 9px;
          display: flex; align-items: center; justify-content: center;
          font-weight: 900; font-size: 0.85rem; color: #fff;
          flex-shrink: 0;
          letter-spacing: -0.05em;
          box-shadow: 0 4px 14px -2px rgba(5,150,105,0.6);
        }
        .nav-name {
          color: #f1f5f9;
          font-weight: 700;
          font-size: 0.9375rem;
          letter-spacing: -0.02em;
          white-space: nowrap;
        }
        .nav-links {
          display: flex;
          align-items: center;
          gap: 0.125rem;
          flex: 1;
          /* Wrap rather than overflow on narrow desktops */
          flex-wrap: wrap;
        }
        .nav-link {
          color: rgba(255, 255, 255, 0.5);
          text-decoration: none;
          font-size: 0.8375rem;
          font-weight: 500;
          padding: 0.375rem 0.7rem;
          border-radius: 6px;
          transition: color 0.12s, background 0.12s;
          white-space: nowrap;
        }
        .nav-link:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
        .nav-link.active { color: #fff; background: rgba(255, 255, 255, 0.1); font-weight: 600; }
        .nav-link:focus-visible {
          outline: 2px solid #34d399;
          outline-offset: 2px;
        }
        .nav-right { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
        .nav-theme-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          /* 44×44 pt minimum touch target */
          width: 44px; height: 44px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          color: rgba(255, 255, 255, 0.6);
          cursor: pointer;
          transition: background 0.12s, border-color 0.12s, color 0.12s;
        }
        .nav-theme-btn:hover {
          background: rgba(255, 255, 255, 0.12);
          border-color: rgba(255, 255, 255, 0.2);
          color: #fff;
        }
        .nav-theme-btn:focus-visible {
          outline: 2px solid #34d399;
          outline-offset: 2px;
        }
        .nav-pill {
          display: inline-flex; align-items: center;
          background: transparent;
          border: 1.5px solid rgba(255, 255, 255, 0.14);
          border-radius: 7px;
          color: rgba(255, 255, 255, 0.65);
          cursor: pointer;
          font: 500 0.8rem/1 inherit;
          padding: 0.375rem 0.875rem;
          transition: all 0.12s;
          text-decoration: none;
          white-space: nowrap;
        }
        .nav-pill:hover {
          border-color: rgba(255, 255, 255, 0.3);
          color: #fff;
          background: rgba(255, 255, 255, 0.06);
        }
        .nav-pill:focus-visible {
          outline: 2px solid #34d399;
          outline-offset: 2px;
        }
        .nav-pill-accent {
          background: linear-gradient(135deg, #059669 0%, #0d9488 100%);
          border: none;
          color: #fff;
          font-weight: 700;
          box-shadow: 0 4px 14px -3px rgba(5,150,105,0.6);
        }
        .nav-pill-accent:hover {
          filter: brightness(1.08);
          color: #fff;
          background: linear-gradient(135deg, #059669 0%, #0d9488 100%);
        }
        .nav-lang {
          appearance: none;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 7px;
          color: rgba(255, 255, 255, 0.8);
          font: 500 0.8rem/1 inherit;
          padding: 0.4rem 0.55rem;
          cursor: pointer;
          outline: none;
        }
        .nav-lang:hover {
          background: rgba(255, 255, 255, 0.12);
          border-color: rgba(255, 255, 255, 0.22);
        }
        .nav-lang:focus-visible {
          outline: 2px solid #34d399;
          outline-offset: 2px;
        }
        .nav-hamburger {
          display: none;
          align-items: center;
          justify-content: center;
          /* 44×44 pt minimum touch target — Apple HIG / Material */
          width: 44px; height: 44px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 7px;
          cursor: pointer;
          color: rgba(255, 255, 255, 0.7);
          font-size: 1.1rem;
          line-height: 1;
        }
        .nav-hamburger:focus-visible {
          outline: 2px solid #34d399;
          outline-offset: 2px;
        }

        /* ── Mobile overlay backdrop ───────────────────── */
        .nav-mobile-backdrop {
          display: none;
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          z-index: 198;
          backdrop-filter: blur(2px);
        }
        .nav-mobile-backdrop.open { display: block; }

        /* ── Mobile drawer ────────────────────────────── */
        .nav-mobile {
          position: fixed;
          top: 0;
          left: 0;
          width: min(320px, 88vw);
          height: 100dvh;
          background: #0c1525;
          border-right: 1px solid rgba(255, 255, 255, 0.08);
          z-index: 199;
          display: flex;
          flex-direction: column;
          padding: 0;
          transform: translateX(-100%);
          transition: transform 0.24s cubic-bezier(0.4, 0, 0.2, 1);
          /* No horizontal scroll inside the drawer */
          overflow-x: hidden;
          overflow-y: auto;
        }
        .nav-mobile.open {
          transform: translateX(0);
        }
        .nav-mobile-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 1rem 1.25rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.07);
          flex-shrink: 0;
        }
        .nav-mobile-close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px; height: 32px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 7px;
          cursor: pointer;
          color: rgba(255, 255, 255, 0.7);
          font-size: 1rem;
        }
        .nav-mobile-close:focus-visible {
          outline: 2px solid #34d399;
          outline-offset: 2px;
        }
        .nav-mobile-body {
          flex: 1;
          padding: 0.75rem 0.75rem 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 0.125rem;
          overflow-y: auto;
          overflow-x: hidden;
        }
        .nav-mobile-section {
          padding: 0.75rem 0.5rem 0.25rem;
          font-size: 0.62rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.14em;
          color: rgba(255, 255, 255, 0.3);
        }
        .nav-mobile-link {
          display: flex;
          align-items: center;
          gap: 0.625rem;
          padding: 0.7rem 0.875rem;
          border-radius: 9px;
          color: rgba(255, 255, 255, 0.6);
          font-size: 0.9rem;
          font-weight: 500;
          text-decoration: none;
          transition: color 0.12s, background 0.12s;
        }
        .nav-mobile-link:hover  { color: #fff; background: rgba(255,255,255,0.08); }
        .nav-mobile-link.active { color: #fff; background: rgba(255,255,255,0.12); font-weight: 600; }
        .nav-mobile-link:focus-visible {
          outline: 2px solid #34d399;
          outline-offset: -2px;
        }
        .nav-mobile-divider {
          height: 1px;
          background: rgba(255,255,255,0.07);
          margin: 0.5rem 0;
        }
        /* Mobile nav links need ≥44pt touch targets */
        .nav-mobile .nav-link {
          min-height: 44px;
          display: flex;
          align-items: center;
          padding: 0.625rem 0.75rem;
        }
        @media (max-width: 720px) {
          .nav-links { display: none; }
          .nav-hamburger { display: flex; }
          /* Ensure the navbar bar itself never causes horizontal scroll */
          .nav-inner { gap: 0.75rem; }
        }

        /* Very narrow screens: shrink brand name */
        @media (max-width: 380px) {
          .nav-name { display: none; }
          .nav-inner { padding: 0 1rem; }
        }
      `}</style>

      <TestnetBanner />
      <nav className="nav" aria-label={t("nav.mainNavAria")}>
        <div className="nav-inner">
          <Link href="/" className="nav-brand" aria-label="StellarEduPay home">
            <div className="nav-logo" aria-hidden="true">S</div>
            <span className="nav-name">StellarEduPay</span>
          </Link>

          <div className="nav-links">
            {visibleLinks.map(({ href, i18nKey, locked, lockedTooltip }) => (
              <NavLink
                key={href}
                href={href}
                role="listitem"
                className={`nav-link${pathname === href ? " active" : ""}`}
                aria-current={pathname === href ? "page" : undefined}
                onMouseEnter={href === "/dashboard" ? prefetchDashboardData : undefined}
                onFocus={href === "/dashboard" ? prefetchDashboardData : undefined}
              >
                {t(i18nKey)}
              </Link>
            ))}
          </div>

          <div className="nav-right">
            <select
              className="nav-lang"
              value={i18n.resolvedLanguage || "en"}
              onChange={(e) => i18n.changeLanguage(e.target.value)}
              aria-label={t("nav.language")}
            >
              {SUPPORTED_LOCALES.map((lng) => (
                <option key={lng} value={lng}>{LOCALE_NAMES[lng]}</option>
              ))}
            </select>
            <button
              className="nav-theme-btn"
              onClick={toggle}
              aria-label={dark ? t("nav.switchToLight") : t("nav.switchToDark")}
            >
              {dark ? <SunIcon /> : <MoonIcon />}
            </button>
            {isAdmin && <NotificationCenter />}
            {isAdmin
              ? <button className="nav-pill" onClick={logout}>{t("actions.signOut")}</button>
              : <Link href="/login" className="nav-pill nav-pill-accent">{t("nav.adminLogin")}</Link>
            }
            <button
              ref={hamburgerRef}
              className="nav-hamburger"
              onClick={() => setOpen(o => !o)}
              aria-expanded={open}
              aria-controls="nav-mobile-drawer"
              aria-label={open ? t("nav.closeMenu") : t("nav.openMenu")}
            >
              {open ? "✕" : "☰"}
            </button>
          </div>
        </div>
      </nav>

      <div className={`nav-mobile${open ? " open" : ""}`} aria-hidden={!open}>
        {visibleLinks.map(({ href, i18nKey, locked, lockedTooltip }) => (
          locked ? (
            <span
              key={href}
              className="nav-link"
              style={{
                color: "rgba(255,255,255,0.25)",
                cursor: "default",
                display: "flex",
                alignItems: "center",
                gap: "0.375rem",
              }}
              title={lockedTooltip || "Requires upgrade"}
              role="presentation"
            >
              {t(i18nKey)}
              <LockIcon />
            </span>
          ) : (
            <Link
              key={href}
              href={href}
              className={`nav-link${pathname === href ? " active" : ""}`}
              aria-current={pathname === href ? "page" : undefined}
              onClick={closeMenu}
              onMouseEnter={href === "/dashboard" ? prefetchDashboardData : undefined}
              onFocus={href === "/dashboard" ? prefetchDashboardData : undefined}
            >
              {t(i18nKey)}
            </Link>
          )
        ))}
        <div className="nav-mobile-divider" />
        {isAdmin
          ? <button className="nav-pill" onClick={() => { logout(); setOpen(false); }} style={{ marginTop: "0.25rem", width: "fit-content" }}>{t("actions.signOut")}</button>
          : <Link href="/login" className="nav-pill nav-pill-accent" style={{ marginTop: "0.25rem", width: "fit-content" }} onClick={() => setOpen(false)}>{t("nav.adminLogin")}</Link>
        }
      </div>
    </>
  );
}
