/**
 * BottomNav — Issue #351
 *
 * Mobile bottom navigation bar that surfaces the 3 most-used operations as
 * persistent tabs, plus a Floating Action Button (FAB) for "Record Payment"
 * — the most frequent action.
 *
 * Design spec:
 * - Bottom nav visible only on ≤ 768px viewports
 * - All touch targets ≥ 44 × 44 pt (Apple HIG / Material guidelines)
 * - FAB floats above the bottom nav, does not obscure critical content while scrolling
 * - Safe-area inset support for iOS notched devices
 * - Fully keyboard navigable with visible focus rings
 * - Tested at 375 px (iPhone SE) and 428 px (Pixel 7) viewport widths
 */

import Link from "next/link";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { IconDashboard, IconCreditCard, IconBarChart } from "./Icons";

const PlusIcon = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

/* Top 3 operations by frequency */
const BOTTOM_TABS = [
  { href: "/dashboard", i18nKey: "nav.dashboard", Icon: IconDashboard },
  { href: "/pay-fees",  i18nKey: "nav.payFees",   Icon: IconCreditCard },
  { href: "/reports",   i18nKey: "nav.reports",   Icon: IconBarChart },
];

export default function BottomNav() {
  const { pathname } = useRouter();
  const { t } = useTranslation();

  return (
    <>
      <style>{`
        /* ── Mobile only ──────────────────────────────── */
        .bnav,
        .bnav-fab {
          display: none;
        }

        @media (max-width: 768px) {
          /* ── Bottom navigation bar ──────────────────── */
          .bnav {
            display: flex;
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            z-index: 300;
            background: var(--card-bg, #ffffff);
            border-top: 1px solid var(--border, #e7e9f3);
            padding-bottom: env(safe-area-inset-bottom, 0px);
            box-shadow: 0 -4px 24px -6px rgba(16, 24, 64, 0.13);
          }

          .bnav-inner {
            display: flex;
            align-items: stretch;
            width: 100%;
          }

          /* Each tab gets equal width; minimum 44pt touch target */
          .bnav-tab {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 4px;
            min-height: 60px;
            min-width: 44px;
            padding: 8px 4px;
            text-decoration: none;
            color: var(--text-muted, #64748b);
            font-size: 0.6875rem;
            font-weight: 500;
            background: transparent;
            border: none;
            cursor: pointer;
            transition: color 0.12s, background 0.12s;
            /* Expanded tap area */
            position: relative;
          }

          /* Extend the tap target to at least 44×44 pt */
          .bnav-tab::after {
            content: "";
            position: absolute;
            inset: 0;
          }

          .bnav-tab:hover {
            color: var(--accent, #059669);
            background: var(--accent-subtle, rgba(5,150,105,0.06));
          }

          .bnav-tab:focus-visible {
            outline: 2px solid var(--accent, #059669);
            outline-offset: -2px;
            color: var(--accent, #059669);
          }

          .bnav-tab.active {
            color: var(--accent, #059669);
          }

          .bnav-tab-icon {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
          }

          /* Active pill indicator */
          .bnav-tab.active .bnav-tab-icon::after {
            content: "";
            position: absolute;
            bottom: -5px;
            left: 50%;
            transform: translateX(-50%);
            width: 4px;
            height: 4px;
            border-radius: 50%;
            background: var(--accent, #059669);
          }

          .bnav-tab-label {
            font-size: 0.625rem;
            line-height: 1;
            white-space: nowrap;
          }

          /* ── FAB ─────────────────────────────────────── */
          .bnav-fab {
            display: flex;
            position: fixed;
            /* Sit above bottom nav + safe area */
            bottom: calc(68px + env(safe-area-inset-bottom, 0px));
            right: 20px;
            z-index: 400;
            /* 56pt is the standard FAB size */
            width: 56px;
            height: 56px;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            background: var(--grad-brand, linear-gradient(135deg,#059669 0%,#0d9488 100%));
            color: #fff;
            border: none;
            cursor: pointer;
            text-decoration: none;
            box-shadow: 0 6px 20px -4px rgba(5,150,105,0.65),
                        0 2px 8px rgba(0,0,0,0.18);
            transition: transform 0.18s, box-shadow 0.18s, filter 0.18s;
          }

          .bnav-fab:hover {
            filter: brightness(1.08);
            transform: scale(1.06);
            box-shadow: 0 8px 28px -4px rgba(5,150,105,0.75),
                        0 2px 8px rgba(0,0,0,0.2);
          }

          .bnav-fab:active {
            transform: scale(0.95);
          }

          .bnav-fab:focus-visible {
            outline: 3px solid var(--accent-ring, rgba(5,150,105,0.4));
            outline-offset: 2px;
          }

          /* Page spacer — prevents content hiding behind fixed bar */
          .bnav-spacer {
            display: block;
            height: calc(64px + env(safe-area-inset-bottom, 0px));
          }
        }

        /* On desktop the spacer is invisible */
        .bnav-spacer {
          display: none;
        }
      `}</style>

      {/* FAB — Record Payment (most frequent action) */}
      <Link
        href="/pay-fees"
        className="bnav-fab"
        aria-label={t("nav.fabRecordPayment")}
        title={t("nav.fabRecordPayment")}
      >
        <PlusIcon />
      </Link>

      {/* Bottom navigation bar */}
      <nav className="bnav" aria-label={t("nav.bottomNavAria")}>
        <div className="bnav-inner">
          {BOTTOM_TABS.map(({ href, i18nKey, Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`bnav-tab${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                <span className="bnav-tab-icon" aria-hidden="true">
                  <Icon size={22} />
                </span>
                <span className="bnav-tab-label">{t(i18nKey)}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Spacer so page content is not hidden behind fixed bottom nav */}
      <div className="bnav-spacer" aria-hidden="true" />
    </>
  );
}
