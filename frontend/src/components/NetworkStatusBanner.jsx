/**
 * NetworkStatusBanner — Issue #21
 *
 * Renders a non-blocking sticky banner that announces browser network
 * connectivity changes to sighted users and screen readers.
 *
 * States:
 *   offline    — shown while isOnline === false (assertive live region)
 *   backOnline — shown for ~3 s after reconnecting (polite live region)
 *   hidden     — isOnline and !wasOffline → renders nothing
 *
 * The banner is deliberately placed below SseDegradedBanner so the two
 * notifications never overlap: SseDegradedBanner handles SSE-level failures;
 * this banner handles OS/browser-level network absence.
 *
 * Usage:
 *   const { isOnline, wasOffline } = useNetworkStatus();
 *   <SseDegradedBanner ... />
 *   <NetworkStatusBanner isOnline={isOnline} wasOffline={wasOffline} />
 */
import { useTranslation } from 'react-i18next';

const STYLES = {
  base: {
    padding: '0.45rem 1.5rem',
    textAlign: 'center',
    fontWeight: 600,
    fontSize: '0.8rem',
    letterSpacing: '0.01em',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.55rem',
    borderBottom: '1px solid rgba(0,0,0,0.15)',
    zIndex: 999,
    flexWrap: 'wrap',
  },
  offline:    { background: '#1c1917', color: '#fef3c7' },
  backOnline: { background: '#14532d', color: '#d1fae5' },
};

function Dot({ color }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

/**
 * @param {{ isOnline: boolean, wasOffline: boolean }} props
 */
export default function NetworkStatusBanner({ isOnline, wasOffline }) {
  const { t } = useTranslation();

  // Offline — highest priority, assertive announcement.
  if (!isOnline) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        aria-label={t('networkStatus.offlineAria', 'Network connectivity lost')}
        style={{ ...STYLES.base, ...STYLES.offline }}
      >
        <Dot color="#fcd34d" />
        <span>{t('networkStatus.offline', 'You are offline. Payment submission is disabled.')}</span>
      </div>
    );
  }

  // Just came back online — polite announcement (linger window).
  if (wasOffline) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{ ...STYLES.base, ...STYLES.backOnline }}
      >
        <Dot color="#6ee7b7" />
        <span>{t('networkStatus.backOnline', 'Back online \u2014 refreshing\u2026')}</span>
      </div>
    );
  }

  return null;
}
