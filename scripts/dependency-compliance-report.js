#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runNpm(packagePath, args) {
  try {
    return JSON.parse(execFileSync('npm', args, { cwd: packagePath, encoding: 'utf8' }));
  } catch (error) {
    if (error.stdout) {
      try { return JSON.parse(error.stdout); } catch (_) { return {}; }
    }
    return {};
  }
}

function flattenDependencies(node, result = []) {
  if (!node || !node.dependencies) return result;
  for (const [name, dependency] of Object.entries(node.dependencies)) {
    result.push({ name, version: dependency.version, license: dependency.license || 'UNKNOWN' });
    flattenDependencies(dependency, result);
  }
  return result;
}

function loadExceptions(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'security-exceptions.json'), 'utf8')).exceptions;
}

function createReport(packagePath) {
  const repoRoot = path.resolve(__dirname, '..');
  const packageRoot = path.resolve(repoRoot, packagePath);
  const outdated = runNpm(packageRoot, ['outdated', '--json']);
  const tree = runNpm(packageRoot, ['ls', '--json', '--all', '--omit=optional']);
  const today = new Date().toISOString().slice(0, 10);
  const exceptions = loadExceptions(repoRoot).filter((entry) => entry.path === packagePath && entry.expires >= today);
  const unknownLicenses = flattenDependencies(tree).filter((entry) => entry.license === 'UNKNOWN');

  return {
    generatedAt: new Date().toISOString(),
    packagePath,
    outdated: Object.entries(outdated).map(([name, details]) => ({
      name,
      current: details.current,
      wanted: details.wanted,
      latest: details.latest,
      knownException: exceptions.some((entry) => entry.package === name),
    })),
    licenseReview: {
      unknown: unknownLicenses,
      reviewedPackageCount: flattenDependencies(tree).length,
    },
    approvedExceptions: exceptions,
  };
}

function markdown(report) {
  const newOutdated = report.outdated.filter((entry) => !entry.knownException);
  const lines = [
    `## Dependency compliance: \`${report.packagePath}\``,
    `Generated: ${report.generatedAt}`,
    '',
    `- Outdated packages: **${report.outdated.length}** (${newOutdated.length} without a package exception)`,
    `- Packages reviewed for licenses: **${report.licenseReview.reviewedPackageCount}**`,
    `- Packages with unknown licenses: **${report.licenseReview.unknown.length}**`,
    `- Approved security exceptions: **${report.approvedExceptions.length}**`,
    '',
  ];
  if (newOutdated.length) {
    lines.push('### Action required: outdated packages');
    for (const entry of newOutdated) lines.push(`- ${entry.name}: ${entry.current} -> ${entry.latest}`);
    lines.push('');
  }
  if (report.licenseReview.unknown.length) {
    lines.push('### Action required: license metadata');
    for (const entry of report.licenseReview.unknown.slice(0, 100)) lines.push(`- ${entry.name}@${entry.version}`);
    lines.push('');
  }
  if (report.approvedExceptions.length) {
    lines.push('### Known approved exceptions');
    for (const entry of report.approvedExceptions) lines.push(`- ${entry.package} ${entry.id}, expires ${entry.expires}`);
  }
  return `${lines.join('\n')}\n`;
}

if (require.main === module) {
  const packagePath = process.argv[2];
  if (!packagePath) {
    console.error('Usage: node scripts/dependency-compliance-report.js <package-path>');
    process.exit(1);
  }

  const report = createReport(packagePath);
  const output = process.env.DEPENDENCY_REPORT_OUTPUT || path.join(process.cwd(), `dependency-report-${packagePath.replace(/[^a-z0-9]+/gi, '-')}.json`);
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(markdown(report));
  process.exitCode = report.outdated.some((entry) => !entry.knownException) || report.licenseReview.unknown.length ? 1 : 0;
}

module.exports = { createReport, flattenDependencies, markdown };
