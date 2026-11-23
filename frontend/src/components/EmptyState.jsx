/**
 * EmptyState — Issue #350
 *
 * Reusable empty-state component for list screens.
 * Supports three variants:
 *   - "empty"   : no records exist (default)
 *   - "filtered": no records match the current filters
 *   - "onboarding": first-time school setup (getting-started context)
 *
 * Props:
 *   variant     "empty" | "filtered" | "onboarding"
 *   title       Heading text
 *   description Body text
 *   action      { label, onClick } — primary CTA button
 *   secondaryAction { label, href } — optional secondary link
 *   icon        Optional SVG element override (defaults per variant)
 */

import Link from "next/link";

/* ── Built-in SVG illustrations ─────────────────────────── */

const EmptyBoxIcon = () => (
  <svg
    width="64"
    height="64"
    viewBox="0 0 64 64"
    fill="none"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="8" y="20" width="48" height="36" rx="4" fill="var(--accent-subtle)" stroke="var(--accent)" strokeWidth="2"/>
    <path d="M8 28h48" stroke="var(--accent)" strokeWidth="2"/>
    <path d="M24 28v-8a8 8 0 0 1 16 0v8" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/>
    <circle cx="32" cy="40" r="4" fill="var(--accent)" opacity="0.5"/>
  </svg>
);

const FilterEmptyIcon = () => (
  <svg
    width="64"
    height="64"
    viewBox="0 0 64 64"
    fill="none"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="8" y="10" width="48" height="44" rx="4" fill="var(--warning-bg)" stroke="var(--warning)" strokeWidth="2"/>
    <path d="M18 22h28M22 32h20M26 42h12" stroke="var(--warning)" strokeWidth="2.5" strokeLinecap="round"/>
    <circle cx="48" cy="48" r="10" fill="var(--warning-bg)" stroke="var(--warning)" strokeWidth="2"/>
    <path d="M44 48h8M48 44v8" stroke="var(--warning)" strokeWidth="2" strokeLinecap="round"/>
  </svg>
);

const OnboardingIcon = () => (
  <svg
    width="64"
    height="64"
    viewBox="0 0 64 64"
    fill="none"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="32" cy="32" r="26" fill="var(--accent-subtle)" stroke="var(--accent)" strokeWidth="2"/>
    <path d="M22 32l7 7 13-14" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="32" cy="18" r="4" fill="var(--accent)" opacity="0.3"/>
    <path d="M32 22v6" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/>
  </svg>
);

const ICONS = {
  empty:       <EmptyBoxIcon />,
  filtered:    <FilterEmptyIcon />,
  onboarding:  <OnboardingIcon />,
};

/* ── Component ───────────────────────────────────────────── */

export default function EmptyState({
  variant = "empty",
  title,
  description,
  action,
  secondaryAction,
  icon,
}) {
  const resolvedIcon = icon ?? ICONS[variant] ?? ICONS.empty;

  return (
    <>
      <style>{`
        .es-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 3.5rem 2rem;
          gap: 0;
          animation: esFadeIn 0.3s ease both;
        }
        @keyframes esFadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .es-icon {
          margin-bottom: 1.25rem;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .es-title {
          font-size: 1rem;
          font-weight: 700;
          color: var(--text);
          margin: 0 0 0.5rem;
        }
        .es-desc {
          font-size: 0.875rem;
          color: var(--text-muted);
          max-width: 380px;
          line-height: 1.6;
          margin: 0 0 1.5rem;
        }
        .es-actions {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          flex-wrap: wrap;
          justify-content: center;
        }
        .es-btn-primary {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.5rem 1.1rem;
          background: var(--grad-brand);
          color: #fff;
          border: none;
          border-radius: var(--radius-sm);
          font: 600 0.875rem/1 inherit;
          cursor: pointer;
          text-decoration: none;
          transition: filter 0.15s, box-shadow 0.15s;
          box-shadow: var(--shadow-glow);
          min-height: 44px;
        }
        .es-btn-primary:hover { filter: brightness(1.08); color: #fff; }
        .es-btn-secondary {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.5rem 1rem;
          background: transparent;
          color: var(--text-muted);
          border: 1.5px solid var(--border);
          border-radius: var(--radius-sm);
          font: 500 0.875rem/1 inherit;
          cursor: pointer;
          text-decoration: none;
          transition: background 0.15s, border-color 0.15s, color 0.15s;
          min-height: 44px;
        }
        .es-btn-secondary:hover {
          background: var(--bg-subtle);
          border-color: var(--border-strong);
          color: var(--text);
        }
      `}</style>

      <div
        className="es-wrap"
        role="status"
        aria-label={title}
      >
        <div className="es-icon" aria-hidden="true">
          {resolvedIcon}
        </div>

        <p className="es-title">{title}</p>

        {description && (
          <p className="es-desc">{description}</p>
        )}

        {(action || secondaryAction) && (
          <div className="es-actions">
            {action && (
              <button
                type="button"
                className="es-btn-primary"
                onClick={action.onClick}
              >
                {action.label}
              </button>
            )}
            {secondaryAction && (
              <Link href={secondaryAction.href} className="es-btn-secondary">
                {secondaryAction.label}
              </Link>
            )}
          </div>
        )}
      </div>
    </>
  );
}
