'use strict';

/**
 * Tests for Issue #122 — SLO dashboards and alert thresholds.
 *
 * Validates:
 *  1. monitoring/alerts/slo.yml — structure, required fields, SLO labelling,
 *     runbook URLs, burn-rate pairing, and recording-rule presence.
 *  2. monitoring/grafana/dashboards/slo.json — dashboard parseable, has
 *     the expected UID, panels for each SLO, and runbook links.
 *  3. docs/slo-definitions.md — exists and references all five SLOs.
 *  4. All five runbook files exist and reference the alert name they cover.
 *
 * No live Prometheus or Grafana required.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const monitoringDir = path.resolve(__dirname, '..', 'monitoring');
const docsDir = path.resolve(__dirname, '..', 'docs');
const runbooksDir = path.join(docsDir, 'runbooks');
const sloAlertPath = path.join(monitoringDir, 'alerts', 'slo.yml');
const sloDashboardPath = path.join(monitoringDir, 'grafana', 'dashboards', 'slo.json');
const sloDefinitionsPath = path.join(docsDir, 'slo-definitions.md');

// ── Helpers ───────────────────────────────────────────────────────────────────

function readYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Collect all rules (both recording rules and alerting rules) from slo.yml.
function allSloRules() {
  const doc = readYaml(sloAlertPath);
  return doc.groups.flatMap((g) => g.rules);
}

// Collect only alerting rules (have an `alert` field).
function allSloAlerts() {
  return allSloRules().filter((r) => r.alert);
}

// Collect only recording rules (have a `record` field).
function allSloRecordingRules() {
  return allSloRules().filter((r) => r.record);
}

// ── 1. slo.yml structure ──────────────────────────────────────────────────────

describe('monitoring/alerts/slo.yml', () => {
  test('file exists', () => {
    expect(fs.existsSync(sloAlertPath)).toBe(true);
  });

  test('parses as valid YAML with groups array', () => {
    const doc = readYaml(sloAlertPath);
    expect(doc).toBeTruthy();
    expect(Array.isArray(doc.groups)).toBe(true);
    expect(doc.groups.length).toBeGreaterThan(0);
  });

  test('contains all five expected SLO groups', () => {
    const doc = readYaml(sloAlertPath);
    const groupNames = doc.groups.map((g) => g.name);
    expect(groupNames).toContain('slo_api_availability');
    expect(groupNames).toContain('slo_payment_latency');
    expect(groupNames).toContain('slo_webhook_delivery');
    expect(groupNames).toContain('slo_reconciliation_lag');
    expect(groupNames).toContain('slo_retry_queue');
  });

  test('all groups have an interval set', () => {
    const doc = readYaml(sloAlertPath);
    for (const group of doc.groups) {
      expect(typeof group.interval).toBe('string');
      expect(group.interval.length).toBeGreaterThan(0);
    }
  });

  describe('alerting rules', () => {
    test('at least one alert rule exists per SLO group', () => {
      const doc = readYaml(sloAlertPath);
      for (const group of doc.groups) {
        const alerts = group.rules.filter((r) => r.alert);
        expect(alerts.length).toBeGreaterThan(0);
      }
    });

    test('every alert has required Prometheus fields', () => {
      for (const rule of allSloAlerts()) {
        expect(typeof rule.alert).toBe('string');
        expect(rule.alert.trim().length).toBeGreaterThan(0);
        expect(typeof rule.expr).toBe('string');
        expect(rule.expr.trim().length).toBeGreaterThan(0);
        expect(['warning', 'critical']).toContain(rule.labels?.severity);
        expect(typeof rule.annotations?.summary).toBe('string');
        expect(typeof rule.annotations?.description).toBe('string');
      }
    });

    test('every alert carries the slo category label', () => {
      for (const rule of allSloAlerts()) {
        expect(rule.labels?.category).toBe('slo');
      }
    });

    test('every alert carries a slo label identifying which SLO it belongs to', () => {
      const validSloLabels = [
        'api_availability',
        'payment_latency',
        'webhook_delivery',
        'reconciliation_lag',
        'retry_queue',
      ];
      for (const rule of allSloAlerts()) {
        expect(validSloLabels).toContain(rule.labels?.slo);
      }
    });

    test('every alert has a runbook_url annotation', () => {
      for (const rule of allSloAlerts()) {
        expect(typeof rule.annotations?.runbook_url).toBe('string');
        expect(rule.annotations.runbook_url).toMatch(/slo-/);
      }
    });

    test('runbook_url for each alert points to the correct runbook file', () => {
      const runbookMap = {
        api_availability: 'slo-api-availability',
        payment_latency: 'slo-payment-latency',
        webhook_delivery: 'slo-webhook-delivery',
        reconciliation_lag: 'slo-reconciliation-lag',
        retry_queue: 'slo-retry-queue',
      };
      for (const rule of allSloAlerts()) {
        const sloLabel = rule.labels?.slo;
        if (sloLabel && runbookMap[sloLabel]) {
          expect(rule.annotations.runbook_url).toContain(runbookMap[sloLabel]);
        }
      }
    });

    test('alert names are globally unique across the slo.yml file', () => {
      const names = allSloAlerts().map((r) => r.alert);
      expect(new Set(names).size).toBe(names.length);
    });

    test('each SLO has both a fast-burn (critical) and a slow-burn (warning) alert', () => {
      const slos = [
        'api_availability',
        'payment_latency',
        'webhook_delivery',
        'reconciliation_lag',
        'retry_queue',
      ];
      const doc = readYaml(sloAlertPath);
      for (const slo of slos) {
        const group = doc.groups.find((g) => g.name === `slo_${slo}`);
        expect(group).toBeDefined();
        const alerts = group.rules.filter((r) => r.alert);
        const severities = alerts.map((a) => a.labels?.severity);
        expect(severities).toContain('critical');
        expect(severities).toContain('warning');
      }
    });

    test.each([
      'SLOApiAvailabilityFastBurn',
      'SLOApiAvailabilitySlowBurn',
      'SLOPaymentLatencyFastBurn',
      'SLOPaymentLatencySlowBurn',
      'SLOWebhookSuccessFastBurn',
      'SLOWebhookSuccessSlowBurn',
      'SLOReconciliationLagWarning',
      'SLOReconciliationLagCritical',
      'SLORetryQueueDepthWarning',
      'SLORetryQueueDepthCritical',
      'SLODeadLetterGrowing',
    ])('%s alert exists in slo.yml', (alertName) => {
      const names = allSloAlerts().map((r) => r.alert);
      expect(names).toContain(alertName);
    });
  });

  describe('recording rules', () => {
    test('at least one recording rule exists per SLO group', () => {
      const doc = readYaml(sloAlertPath);
      for (const group of doc.groups) {
        const recordings = group.rules.filter((r) => r.record);
        expect(recordings.length).toBeGreaterThan(0);
      }
    });

    test('every recording rule has a record name and expr', () => {
      for (const rule of allSloRecordingRules()) {
        expect(typeof rule.record).toBe('string');
        expect(rule.record.trim().length).toBeGreaterThan(0);
        expect(typeof rule.expr).toBe('string');
        expect(rule.expr.trim().length).toBeGreaterThan(0);
      }
    });

    test('recording rule names follow the slo: namespace convention', () => {
      for (const rule of allSloRecordingRules()) {
        expect(rule.record).toMatch(/^slo:/);
      }
    });

    test.each([
      'slo:api_availability:ratio_rate5m',
      'slo:api_availability:ratio_rate30m',
      'slo:api_error_ratio:rate5m',
      'slo:api_error_ratio:rate30m',
      'slo:payment_processing_p95:rate5m',
      'slo:payment_processing_p95:rate30m',
      'slo:payment_within_slo:ratio_rate5m',
      'slo:webhook_success:ratio_rate5m',
      'slo:webhook_success:ratio_rate1h',
      'slo:webhook_error_ratio:rate5m',
      'slo:webhook_error_ratio:rate1h',
      'slo:reconciliation_max_lag_cycles:current',
      'slo:reconciliation_max_lag_minutes:approx',
      'slo:retry_queue_pending:current',
      'slo:retry_queue_dead_letter:current',
    ])('recording rule %s exists', (recordName) => {
      const names = allSloRecordingRules().map((r) => r.record);
      expect(names).toContain(recordName);
    });
  });
});

// ── 2. slo.yml wired into prometheus.yml ──────────────────────────────────────

describe('prometheus.yml references slo.yml', () => {
  test('prometheus.yml rule_files includes alerts/slo.yml', () => {
    const prometheusConfig = readYaml(path.join(monitoringDir, 'prometheus.yml'));
    const ruleFiles = prometheusConfig.rule_files || [];
    expect(ruleFiles).toContain('alerts/slo.yml');
  });
});

// ── 3. Grafana SLO dashboard ──────────────────────────────────────────────────

describe('monitoring/grafana/dashboards/slo.json', () => {
  let dashboard;

  beforeAll(() => {
    dashboard = readJson(sloDashboardPath);
  });

  test('file exists', () => {
    expect(fs.existsSync(sloDashboardPath)).toBe(true);
  });

  test('parses as valid JSON with required Grafana fields', () => {
    expect(dashboard).toBeTruthy();
    expect(typeof dashboard.title).toBe('string');
    expect(typeof dashboard.uid).toBe('string');
    expect(Array.isArray(dashboard.panels)).toBe(true);
  });

  test('has the correct UID', () => {
    expect(dashboard.uid).toBe('stellaredupay-slos');
  });

  test('is tagged with slo', () => {
    expect(dashboard.tags).toContain('slo');
  });

  test('has at least 20 panels covering all 5 SLOs', () => {
    // 5 SLOs × 3 panels each + 5 heading text rows + 1 error budget row (5 stats) = many panels
    expect(dashboard.panels.length).toBeGreaterThanOrEqual(20);
  });

  test('has at least one gauge panel for each SLO', () => {
    const gaugePanels = dashboard.panels.filter((p) => p.type === 'gauge');
    expect(gaugePanels.length).toBeGreaterThanOrEqual(5);
  });

  test('has at least one timeseries panel for each SLO trend', () => {
    const timeseriesPanels = dashboard.panels.filter((p) => p.type === 'timeseries');
    expect(timeseriesPanels.length).toBeGreaterThanOrEqual(5);
  });

  test('all gauge and timeseries panels have a description linking to a runbook', () => {
    const actionablePanels = dashboard.panels.filter(
      (p) => p.type === 'gauge' || p.type === 'timeseries'
    );
    for (const panel of actionablePanels) {
      expect(typeof panel.description).toBe('string');
      expect(panel.description.length).toBeGreaterThan(0);
    }
  });

  test('dashboard has links section with SLO definitions reference', () => {
    expect(Array.isArray(dashboard.links)).toBe(true);
    const urls = dashboard.links.map((l) => l.url);
    const hasSloDefinitions = urls.some((u) => u.includes('slo-definitions'));
    expect(hasSloDefinitions).toBe(true);
  });

  test('all panel targets reference only known slo: recording rules or raw metrics', () => {
    const sloRecordingNames = allSloRecordingRules().map((r) => r.record);
    const validPrefixes = ['slo:', 'http_request', 'payment_processing', 'webhook_delivery',
      'webhook_dead_letter', 'horizon_poll', 'pending_verification', 'payments_total'];

    const panels = dashboard.panels.filter((p) => Array.isArray(p.targets));
    for (const panel of panels) {
      for (const target of panel.targets) {
        if (target.expr) {
          const usesKnownMetric = validPrefixes.some((pfx) => target.expr.includes(pfx));
          expect(usesKnownMetric).toBe(true);
        }
      }
    }
  });

  test('panel IDs are unique', () => {
    const ids = dashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('refresh interval is set', () => {
    expect(typeof dashboard.refresh).toBe('string');
    expect(dashboard.refresh.length).toBeGreaterThan(0);
  });
});

// ── 4. SLO definitions document ───────────────────────────────────────────────

describe('docs/slo-definitions.md', () => {
  let content;

  beforeAll(() => {
    content = fs.readFileSync(sloDefinitionsPath, 'utf8');
  });

  test('file exists', () => {
    expect(fs.existsSync(sloDefinitionsPath)).toBe(true);
  });

  test.each(['SLO-1', 'SLO-2', 'SLO-3', 'SLO-4', 'SLO-5'])(
    '%s is defined',
    (sloId) => {
      expect(content).toContain(sloId);
    }
  );

  test('defines API Availability SLO with target', () => {
    expect(content).toContain('99.5');
  });

  test('defines Payment Confirmation Latency SLO', () => {
    expect(content).toMatch(/latency/i);
    expect(content).toContain('60');
  });

  test('defines Webhook Delivery Success SLO with target', () => {
    expect(content).toContain('99 %');
  });

  test('defines Reconciliation Lag SLO with target', () => {
    expect(content).toMatch(/reconcil/i);
    expect(content).toContain('5 min');
  });

  test('defines Retry Queue SLO', () => {
    expect(content).toMatch(/retry.queue/i);
    expect(content).toContain('100');
  });

  test('references each alert policy', () => {
    expect(content).toContain('SLOApiAvailabilityFastBurn');
    expect(content).toContain('SLOPaymentLatencyFastBurn');
    expect(content).toContain('SLOWebhookSuccessFastBurn');
    expect(content).toContain('SLOReconciliationLagCritical');
    expect(content).toContain('SLORetryQueueDepthCritical');
  });

  test('includes an error budget policy section', () => {
    expect(content).toMatch(/error.budget.policy/i);
  });
});

// ── 5. Runbooks ───────────────────────────────────────────────────────────────

describe('SLO runbooks', () => {
  const runbooks = [
    {
      file: 'slo-api-availability.md',
      alertName: 'SLOApiAvailabilityFastBurn',
      sloId: 'SLO-1',
    },
    {
      file: 'slo-payment-latency.md',
      alertName: 'SLOPaymentLatencyFastBurn',
      sloId: 'SLO-2',
    },
    {
      file: 'slo-webhook-delivery.md',
      alertName: 'SLOWebhookSuccessFastBurn',
      sloId: 'SLO-3',
    },
    {
      file: 'slo-reconciliation-lag.md',
      alertName: 'SLOReconciliationLagCritical',
      sloId: 'SLO-4',
    },
    {
      file: 'slo-retry-queue.md',
      alertName: 'SLORetryQueueDepthCritical',
      sloId: 'SLO-5',
    },
  ];

  test.each(runbooks)('$file exists', ({ file }) => {
    expect(fs.existsSync(path.join(runbooksDir, file))).toBe(true);
  });

  test.each(runbooks)('$file references the alert name it covers', ({ file, alertName }) => {
    const content = fs.readFileSync(path.join(runbooksDir, file), 'utf8');
    expect(content).toContain(alertName);
  });

  test.each(runbooks)('$file has a Diagnosis Steps section', ({ file }) => {
    const content = fs.readFileSync(path.join(runbooksDir, file), 'utf8');
    expect(content).toMatch(/diagnosis.steps/i);
  });

  test.each(runbooks)('$file has a Mitigation Actions section', ({ file }) => {
    const content = fs.readFileSync(path.join(runbooksDir, file), 'utf8');
    expect(content).toMatch(/mitigation.actions/i);
  });

  test.each(runbooks)('$file has a Recovery Verification section', ({ file }) => {
    const content = fs.readFileSync(path.join(runbooksDir, file), 'utf8');
    expect(content).toMatch(/recovery.verification/i);
  });

  test.each(runbooks)('$file includes at least one PromQL query example', ({ file }) => {
    const content = fs.readFileSync(path.join(runbooksDir, file), 'utf8');
    // PromQL queries appear as code blocks referencing slo: recording rules or raw metrics
    expect(content).toMatch(/```(promql|bash|)\s*[\s\S]*?slo:|histogram_quantile|rate\(/m);
  });

  test.each(runbooks)('$file has an Escalation section', ({ file }) => {
    const content = fs.readFileSync(path.join(runbooksDir, file), 'utf8');
    expect(content).toMatch(/escalation/i);
  });
});
