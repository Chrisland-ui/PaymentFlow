'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const referencePath = path.join(repoRoot, 'docs/environment-reference.md');

function walkJsFiles(relativeDir) {
  const directory = path.join(repoRoot, relativeDir);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsFiles(path.relative(repoRoot, fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

function collectEnvironmentReads() {
  const keys = new Set();
  const roots = ['backend/src', 'backend/migrations', 'scripts', 'frontend/src'];
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /parseTTL\(['"]([A-Z][A-Z0-9_]*)['"]/g,
  ];

  for (const root of roots) {
    for (const file of walkJsFiles(root)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) keys.add(match[1]);
      }
    }
  }

  const nextConfig = path.join(repoRoot, 'frontend/next.config.js');
  const nextSource = fs.readFileSync(nextConfig, 'utf8');
  for (const pattern of patterns) {
    for (const match of nextSource.matchAll(pattern)) keys.add(match[1]);
  }

  return keys;
}

function collectComposeKeys() {
  const keys = new Set();
  const files = ['docker-compose.yml', 'docker-compose.monitoring.yml'];
  const pattern = /\$\{([A-Z][A-Z0-9_]*)(?::?[-?][^}]*)?\}/g;

  for (const file of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    for (const match of source.matchAll(pattern)) keys.add(match[1]);
  }

  return keys;
}

function collectExampleKeys() {
  const keys = new Set();
  const files = ['.env.example', 'backend/.env.example', 'frontend/.env.local.example'];

  for (const file of files) {
    for (const line of fs.readFileSync(path.join(repoRoot, file), 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
      if (match) keys.add(match[1]);
    }
  }

  return keys;
}

function collectReferenceKeys() {
  const source = fs.readFileSync(referencePath, 'utf8');
  return new Set([...source.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((match) => match[1]));
}

function withEnvironment(overrides, callback) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    return callback();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

describe('environment variable reference', () => {
  it('documents every example, runtime, frontend, and Compose variable', () => {
    const expected = new Set([
      ...collectExampleKeys(),
      ...collectEnvironmentReads(),
      ...collectComposeKeys(),
    ]);
    const actual = collectReferenceKeys();
    const missing = [...expected].filter((key) => actual.has(key) === false).sort();

    expect(missing).toEqual([]);
  });

  it('does not contain secret assignments', () => {
    const source = fs.readFileSync(referencePath, 'utf8');
    expect(source).not.toMatch(/\b(?:SECRET|PASSWORD|TOKEN|API_KEY|AUTH_TOKEN)\b\s*=\s*\S+/i);
  });

  it('describes the required startup failures', () => {
    const validSecret = 'a-sufficiently-long-secret-value-1234567890';

    expect(() => withEnvironment({ JWT_SECRET: validSecret }, () => {
      jest.resetModules();
      require('../backend/src/config/index');
    })).toThrow(/Missing required environment variables.*MONGO_URI/);

    expect(() => withEnvironment({ MONGO_URI: 'mongodb://localhost/test' }, () => {
      jest.resetModules();
      require('../backend/src/config/index');
    })).toThrow(/Missing required environment variables.*JWT_SECRET/);
  });
});
