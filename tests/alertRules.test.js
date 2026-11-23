'use strict';

/**
 * Validates monitoring/alerts/*.yml without needing a live Prometheus
 * (promtool) — catches the two failure modes that make an alert file
 * worthless even though it parses: a rule missing required fields, and a
 * rule file that exists on disk but isn't wired into prometheus.yml's
 * rule_files (which happened previously for receipts.yml and
 * monitoring/webhook_alerts.yml — the latter was outside monitoring/alerts/
 * entirely and so was never mounted into the Prometheus container at all).
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const monitoringDir = path.resolve(__dirname, '..', 'monitoring');
const alertsDir = path.join(monitoringDir, 'alerts');

function readYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

const alertFiles = fs
  .readdirSync(alertsDir)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

describe('monitoring/alerts rule files', () => {
  test('at least one alert file exists', () => {
    expect(alertFiles.length).toBeGreaterThan(0);
  });

  test('every alert file in monitoring/alerts is referenced by prometheus.yml rule_files', () => {
    const prometheusConfig = readYaml(path.join(monitoringDir, 'prometheus.yml'));
    const ruleFiles = (prometheusConfig.rule_files || []).map((p) => p.replace(/^alerts\//, ''));

    for (const file of alertFiles) {
      expect(ruleFiles).toContain(file);
    }
  });

  test('every referenced rule_files entry exists on disk', () => {
    const prometheusConfig = readYaml(path.join(monitoringDir, 'prometheus.yml'));
    for (const relativePath of prometheusConfig.rule_files || []) {
      const fullPath = path.join(monitoringDir, relativePath);
      expect(fs.existsSync(fullPath)).toBe(true);
    }
  });

  describe.each(alertFiles)('%s', (file) => {
    let doc;

    beforeAll(() => {
      doc = readYaml(path.join(alertsDir, file));
    });

    test('parses as valid YAML with at least one group', () => {
      expect(doc).toBeTruthy();
      expect(Array.isArray(doc.groups)).toBe(true);
      expect(doc.groups.length).toBeGreaterThan(0);
    });

    test('every rule has the required Prometheus alerting fields', () => {
      for (const group of doc.groups) {
        expect(typeof group.name).toBe('string');
        expect(Array.isArray(group.rules)).toBe(true);
        expect(group.rules.length).toBeGreaterThan(0);

        // Prometheus rule groups can contain both recording rules (with a `record`
        // field) and alerting rules (with an `alert` field). Only alerting rules
        // are checked for the required severity/annotations fields.
        const alertingRules = group.rules.filter((r) => r.alert !== undefined);
        for (const rule of alertingRules) {
          expect(typeof rule.alert).toBe('string');
          expect(rule.alert.length).toBeGreaterThan(0);
          expect(typeof rule.expr).toBe('string');
          expect(rule.expr.trim().length).toBeGreaterThan(0);
          expect(['warning', 'critical']).toContain(rule.labels && rule.labels.severity);
          expect(typeof rule.annotations?.summary).toBe('string');
          expect(typeof rule.annotations?.description).toBe('string');
        }
      }
    });

    test('alert names are unique within the file', () => {
      // Only collect alerting rules (not recording rules which have no `alert` field).
      const names = doc.groups
        .flatMap((g) => g.rules.filter((r) => r.alert !== undefined).map((r) => r.alert));
      expect(new Set(names).size).toBe(names.length);
    });
  });
});

describe('payment-processing critical-path alert coverage', () => {
  function allAlertNames() {
    return alertFiles.flatMap((file) => {
      const doc = readYaml(path.join(alertsDir, file));
      return doc.groups.flatMap((g) => g.rules.map((r) => r.alert));
    });
  }

  test.each([
    'ApiHigh5xxRateWarning',
    'ApiHigh5xxRateCritical',
    'ApiLatencyP95High',
    'ApiLatencyP99Critical',
    'MongoDBDisconnected',
    'MongoDBConnectionErrorsElevated',
    'HorizonCircuitBreakerOpen',
    'HorizonAllEndpointsUnavailable',
    'PaymentQueueBackpressureHighWater',
    'PaymentQueueNearCapacity',
    // #1102 — backup staleness alerting
    'BackupStale',
    'BackupCriticallyStale',
    'BackupNotRun',
    // #122 — SLO alerts
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
  ])('%s alert rule exists', (alertName) => {
    expect(allAlertNames()).toContain(alertName);
  });
});
