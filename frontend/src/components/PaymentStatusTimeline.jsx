/**
 * PaymentStatusTimeline — Issue #3
 *
 * A reusable timeline component that renders payment status transitions
 * consistently across list and detail views.
 *
 * Supports all canonical payment statuses (PENDING, SUBMITTED, SUCCESS,
 * FAILED, DISPUTED, REFUNDED, INVALID) plus an unknown-status fallback.
 *
 * Lifecycle steps shown in expanded mode:
 *   Created → Processing → Provider Confirmed → Blockchain Submitted → Settled
 *   (or branching to Failed / Disputed)
 *
 * Accessibility
 * -------------
 * - Renders as an <ol> so screen readers receive ordered status information.
 * - Each step is a <li role="listitem">.
 * - The active/current status has aria-current="step".
 * - Timestamps use <time datetime={isoString}> for machine-readable dates.
 * - Icons are aria-hidden; status label provides the accessible text.
 *
 * @param {object}   props
 * @param {Array}    [props.payments]        Array of { status, createdAt, txHash } for history timeline.
 * @param {string}   [props.currentStatus]   Single status for standalone indicator mode.
 * @param {boolean}  [props.compact=false]   Compact layout for list views.
 * @param {string}   [props.className]       Additional CSS class.
 */
import React from 'react';
import { PAYMENT_STATUS, PAYMENT_STATUS_LABELS, isTerminalStatus } from '../utils/paymentStatus';
import TimestampDisplay from './TimestampDisplay';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_STYLE = {
  [PAYMENT_STATUS.PENDING]:   { color: 'var(--warning)',    icon: '⏳', badgeClass: 'badge-warning'  },
  [PAYMENT_STATUS.SUBMITTED]: { color: 'var(--info)',       icon: '↥',  badgeClass: 'badge-info'     },
  [PAYMENT_STATUS.SUCCESS]:   { color: 'var(--success)',    icon: '✓',  badgeClass: 'badge-success'  },
  [PAYMENT_STATUS.FAILED]:    { color: 'var(--danger)',     icon: '✗',  badgeClass: 'badge-danger'   },
  [PAYMENT_STATUS.DISPUTED]:  { color: 'var(--warning)',    icon: '⚠',  badgeClass: 'badge-warning'  },
  [PAYMENT_STATUS.REFUNDED]:  { color: 'var(--text-muted)', icon: '↺', badgeClass: 'badge-neutral'  },
  [PAYMENT_STATUS.INVALID]:   { color: 'var(--danger)',     icon: '⊗',  badgeClass: 'badge-danger'   },
};

const UNKNOWN_STYLE = { color: 'var(--text-muted)', icon: '?', badgeClass: 'badge-neutral' };

/**
 * Ordered lifecycle steps shown in expanded mode.
 * Each step maps to a canonical status or a descriptive stage name.
 */
const LIFECYCLE_STEPS = [
  {
    id: 'created',
    label: 'Created',
    description: 'Payment record created and awaiting blockchain submission.',
    icon: '📋',
    matchesStatus: [PAYMENT_STATUS.PENDING],
  },
  {
    id: 'processing',
    label: 'Processing',
    description: 'Transaction submitted to the Stellar network and being verified.',
    icon: '⚙',
    matchesStatus: [PAYMENT_STATUS.SUBMITTED],
  },
  {
    id: 'blockchain_confirmed',
    label: 'Blockchain Confirmed',
    description: 'Transaction confirmed on the Stellar blockchain ledger.',
    icon: '⛓',
    matchesStatus: [PAYMENT_STATUS.SUBMITTED, PAYMENT_STATUS.SUCCESS],
  },
  {
    id: 'settled',
    label: 'Settled',
    description: 'Payment fully verified and student record updated.',
    icon: '✅',
    matchesStatus: [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.REFUNDED],
  },
];

const FAILED_GUIDANCE = {
  [PAYMENT_STATUS.FAILED]: {
    heading: 'Payment Failed',
    reason: 'The transaction could not be verified on the Stellar network.',
    nextAction: 'Please check your wallet and try the payment again. If the amount was deducted, contact support with your transaction hash.',
    icon: '✗',
  },
  [PAYMENT_STATUS.DISPUTED]: {
    heading: 'Payment Disputed',
    reason: 'This payment has been flagged for review.',
    nextAction: 'A school administrator will review this dispute. You can track the status on the Disputes page or contact the school directly.',
    icon: '⚠',
  },
  [PAYMENT_STATUS.INVALID]: {
    heading: 'Invalid Payment',
    reason: 'The transaction memo or destination address was not recognised.',
    nextAction: 'Ensure you included the correct student ID in the memo field and sent funds to the school\'s wallet address. Retry the payment with the correct details.',
    icon: '⊗',
  },
};

const STELLAR_EXPLORER_BASE = {
  testnet: 'https://stellar.expert/explorer/testnet/tx/',
  mainnet: 'https://stellar.expert/explorer/public/tx/',
};

// ---------------------------------------------------------------------------
// Pure helper exports (used in tests)
// ---------------------------------------------------------------------------

export function getStatusStyle(status) {
  return STATUS_STYLE[(status || '').toUpperCase()] || UNKNOWN_STYLE;
}

export function getStatusLabel(status) {
  if (!status) return 'Unknown';
  return PAYMENT_STATUS_LABELS[(status || '').toUpperCase()] || status;
}

/**
 * Build a Stellar explorer URL for the given transaction hash.
 * @param {string} txHash
 * @param {'testnet'|'mainnet'} network
 * @returns {string|null}
 */
export function buildExplorerUrl(txHash, network = 'testnet') {
  if (!txHash || typeof txHash !== 'string' || txHash.trim() === '') return null;
  const base = STELLAR_EXPLORER_BASE[network] || STELLAR_EXPLORER_BASE.testnet;
  return `${base}${encodeURIComponent(txHash.trim())}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * ExplorerLink — renders a Stellar explorer link for a transaction hash.
 */
export function ExplorerLink({ txHash, network = 'testnet', label = 'View on Explorer' }) {
  const url = buildExplorerUrl(txHash, network);
  if (!url) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="payment-status-timeline__explorer-link"
      aria-label={`${label} (opens in new tab)`}
    >
      {label}
      {/* External link icon, hidden from screen readers */}
      <span aria-hidden="true" className="payment-status-timeline__external-icon">↗</span>
    </a>
  );
}

/**
 * FailedGuidance — renders contextual guidance for failed/disputed/invalid states.
 */
export function FailedGuidance({ status }) {
  const guidance = FAILED_GUIDANCE[(status || '').toUpperCase()];
  if (!guidance) return null;

  return (
    <div
      className="payment-status-timeline__guidance"
      role="alert"
      aria-label={guidance.heading}
    >
      <div className="payment-status-timeline__guidance-heading">
        <span aria-hidden="true" className="payment-status-timeline__guidance-icon">
          {guidance.icon}
        </span>
        <strong>{guidance.heading}</strong>
      </div>
      <p className="payment-status-timeline__guidance-reason">{guidance.reason}</p>
      <p className="payment-status-timeline__guidance-action">
        <strong>Next steps:</strong> {guidance.nextAction}
      </p>
    </div>
  );
}

/**
 * LifecycleSteps — renders the full ordered lifecycle in expanded mode.
 * Marks steps as completed, current, or upcoming based on the current status.
 */
export function LifecycleSteps({ currentStatus, txHash, network = 'testnet' }) {
  // Determine the ordinal position of the current status in the lifecycle
  const statusOrder = [
    PAYMENT_STATUS.PENDING,
    PAYMENT_STATUS.SUBMITTED,
    PAYMENT_STATUS.SUCCESS,
    PAYMENT_STATUS.REFUNDED,
  ];
  const currentIdx = statusOrder.indexOf((currentStatus || '').toUpperCase());
  const isNegativeTerminal = [
    PAYMENT_STATUS.FAILED,
    PAYMENT_STATUS.DISPUTED,
    PAYMENT_STATUS.INVALID,
  ].includes((currentStatus || '').toUpperCase());

  return (
    <ol
      className="payment-status-timeline__lifecycle"
      aria-label="Payment lifecycle steps"
    >
      {LIFECYCLE_STEPS.map((step, idx) => {
        // A step is "reached" if the current status maps to or is past this step
        const stepOrder = statusOrder.findIndex((s) =>
          step.matchesStatus.includes(s)
        );
        const isCompleted = !isNegativeTerminal && currentIdx > stepOrder;
        const isCurrent =
          !isNegativeTerminal &&
          step.matchesStatus.includes((currentStatus || '').toUpperCase());
        const isPending = !isCompleted && !isCurrent;

        // Show blockchain confirmation step details with explorer link
        const showExplorer =
          step.id === 'blockchain_confirmed' &&
          txHash &&
          (isCurrent || isCompleted);

        return (
          <li
            key={step.id}
            className={[
              'payment-status-timeline__lifecycle-step',
              isCompleted ? 'payment-status-timeline__lifecycle-step--completed' : '',
              isCurrent ? 'payment-status-timeline__lifecycle-step--current' : '',
              isPending ? 'payment-status-timeline__lifecycle-step--pending' : '',
            ].filter(Boolean).join(' ')}
            aria-current={isCurrent ? 'step' : undefined}
          >
            <span
              className="payment-status-timeline__lifecycle-dot"
              aria-hidden="true"
            >
              {isCompleted ? '✓' : isCurrent ? step.icon : '○'}
            </span>
            <span className="payment-status-timeline__lifecycle-content">
              <span className="payment-status-timeline__lifecycle-label">
                {step.label}
              </span>
              {(isCurrent || isCompleted) && (
                <span className="payment-status-timeline__lifecycle-desc">
                  {step.description}
                </span>
              )}
              {showExplorer && (
                <ExplorerLink
                  txHash={txHash}
                  network={network}
                  label="View transaction on Stellar Explorer"
                />
              )}
            </span>
          </li>
        );
      })}

      {/* Negative terminal state — appended after lifecycle steps */}
      {isNegativeTerminal && (
        <li
          className="payment-status-timeline__lifecycle-step payment-status-timeline__lifecycle-step--terminal-negative"
          aria-current="step"
        >
          <span
            className={`payment-status-timeline__lifecycle-dot ${getStatusStyle(currentStatus).badgeClass}`}
            aria-hidden="true"
          >
            {getStatusStyle(currentStatus).icon}
          </span>
          <span className="payment-status-timeline__lifecycle-content">
            <span className="payment-status-timeline__lifecycle-label">
              {getStatusLabel(currentStatus)}
            </span>
            <FailedGuidance status={currentStatus} />
            {txHash && (
              <ExplorerLink
                txHash={txHash}
                network={network}
                label="View transaction on Stellar Explorer"
              />
            )}
          </span>
        </li>
      )}
    </ol>
  );
}

/**
 * StatusIndicator — inline badge for a single current status.
 */
export function StatusIndicator({ status, compact }) {
  const style = getStatusStyle(status);
  const label = getStatusLabel(status);
  const terminal = isTerminalStatus(status);

  return (
    <span
      className={[
        'payment-status-indicator',
        compact ? 'payment-status-indicator--compact' : '',
        style.badgeClass,
        terminal ? 'payment-status-indicator--terminal' : '',
      ].filter(Boolean).join(' ')}
      style={{ color: style.color }}
      aria-label={`Payment status: ${label}`}
    >
      <span aria-hidden="true" className="payment-status-indicator__icon">
        {style.icon}
      </span>
      <span className="payment-status-indicator__label">{label}</span>
    </span>
  );
}

export function StatusTimeline({ payments, compact }) {
  if (!payments || payments.length === 0) {
    return (
      <p className="payment-status-timeline__empty" role="status">
        No payment history available.
      </p>
    );
  }

  const lastIndex = payments.length - 1;

  return (
    <ol
      className={['payment-status-timeline', compact ? 'payment-status-timeline--compact' : ''].filter(Boolean).join(' ')}
      aria-label="Payment status history"
    >
      {payments.map((payment, idx) => {
        const status = payment.status;
        const style = getStatusStyle(status);
        const label = getStatusLabel(status);
        const isActive = idx === lastIndex;
        const terminal = isTerminalStatus(status);
        const isoDate = payment.createdAt || null;
        const txHash = payment.txHash || null;

        // Show explorer link for submitted/success states that have a txHash
        const showExplorer = txHash && (
          (status || '').toUpperCase() === PAYMENT_STATUS.SUBMITTED ||
          (status || '').toUpperCase() === PAYMENT_STATUS.SUCCESS
        );

        // Show guidance for terminal negative states
        const showGuidance = isActive && (
          (status || '').toUpperCase() === PAYMENT_STATUS.FAILED ||
          (status || '').toUpperCase() === PAYMENT_STATUS.DISPUTED ||
          (status || '').toUpperCase() === PAYMENT_STATUS.INVALID
        );

        return (
          <li
            key={payment.txHash || `step-${idx}`}
            className={[
              'payment-status-timeline__step',
              isActive ? 'payment-status-timeline__step--active' : '',
              terminal ? 'payment-status-timeline__step--terminal' : '',
            ].filter(Boolean).join(' ')}
            aria-current={isActive ? 'step' : undefined}
          >
            <span
              className={`payment-status-timeline__dot ${style.badgeClass}`}
              style={{ background: style.color }}
              aria-hidden="true"
            >
              {style.icon}
            </span>
            <span className="payment-status-timeline__content">
              <span className="payment-status-timeline__label">{label}</span>
              {isoDate && (
                <span className="payment-status-timeline__time">
                  <TimestampDisplay iso={isoDate} />
                </span>
              )}
              {showExplorer && (
                <ExplorerLink
                  txHash={txHash}
                  network={network}
                  label="View on Stellar Explorer"
                />
              )}
              {showGuidance && <FailedGuidance status={status} />}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default function PaymentStatusTimeline({ payments, currentStatus, compact = false, className = '' }) {
  if (payments && payments.length > 0) {
    return (
      <div className={['payment-status-timeline-wrapper', className].filter(Boolean).join(' ')}>
        <StatusTimeline payments={payments} compact={compact} />
      </div>
    );
  }

  if (currentStatus !== undefined && currentStatus !== null) {
    return (
      <div className={['payment-status-timeline-wrapper', className].filter(Boolean).join(' ')}>
        <StatusIndicator status={currentStatus} compact={compact} />
      </div>
    );
  }

  return null;
}
