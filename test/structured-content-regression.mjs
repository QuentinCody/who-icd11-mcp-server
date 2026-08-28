#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assertContains(filePath, haystack, needle, testName) {
  totalTests++;
  if (haystack.includes(needle)) {
    console.log(`${GREEN}✓${RESET} ${testName}`);
    passedTests++;
  } else {
    console.log(`${RED}✗${RESET} ${testName}`);
    console.log(`  Missing: ${needle}`);
    console.log(`  File: ${filePath}`);
    failedTests++;
  }
}

function assertNotContains(filePath, haystack, needle, testName) {
  totalTests++;
  if (!haystack.includes(needle)) {
    console.log(`${GREEN}\u2713${RESET} ${testName}`);
    passedTests++;
  } else {
    console.log(`${RED}\u2717${RESET} ${testName}`);
    console.log(`  Must not contain: ${needle}`);
    console.log(`  File: ${filePath}`);
    failedTests++;
  }
}

function readFile(relPath) {
  const absPath = path.resolve(SERVER_ROOT, relPath);
  return fs.readFileSync(absPath, 'utf8');
}

console.log(`${BLUE}🧪 WHO ICD-11 Structured Content Regression Tests${RESET}`);

// Verify index.ts structure
const indexContent = readFile('src/index.ts');
assertContains('src/index.ts', indexContent, 'Icd11DataDO', 'index.ts exports Icd11DataDO');
assertContains('src/index.ts', indexContent, 'StatelessMcpWorker', 'index.ts uses StatelessMcpWorker');
assertContains('src/index.ts', indexContent, 'registerCodeMode', 'index.ts registers code mode');
assertContains('src/index.ts', indexContent, 'registerQueryData', 'index.ts registers query data');
assertContains('src/index.ts', indexContent, 'registerGetSchema', 'index.ts registers get schema');

// Verify DO
const doContent = readFile('src/do.ts');
assertContains('src/do.ts', doContent, 'RestStagingDO', 'do.ts extends RestStagingDO');
assertContains('src/do.ts', doContent, 'getSchemaHints', 'do.ts implements getSchemaHints');

// Verify http.ts has OAuth
const httpContent = readFile('src/lib/http.ts');
assertContains('src/lib/http.ts', httpContent, 'getAccessToken', 'http.ts has OAuth token fetch');
assertContains('src/lib/http.ts', httpContent, 'icdaccessmanagement.who.int', 'http.ts uses WHO token endpoint');
assertContains('src/lib/http.ts', httpContent, 'API-Version', 'http.ts sends API-Version header');
assertContains('src/lib/http.ts', httpContent, 'Bearer', 'http.ts sends Bearer token');

// Verify api-adapter.ts
const adapterContent = readFile('src/lib/api-adapter.ts');
assertContains('src/lib/api-adapter.ts', adapterContent, 'ApiFetchFn', 'api-adapter uses ApiFetchFn');
assertContains('src/lib/api-adapter.ts', adapterContent, 'icd11Fetch', 'api-adapter delegates to icd11Fetch');

// Verify catalog
const catalogContent = readFile('src/spec/catalog.ts');
assertContains('src/spec/catalog.ts', catalogContent, 'ApiCatalog', 'catalog uses ApiCatalog type');
assertContains('src/spec/catalog.ts', catalogContent, '/entity/search', 'catalog has entity search');
assertContains('src/spec/catalog.ts', catalogContent, '/release/11/', 'catalog has linearization endpoints');
assertContains('src/spec/catalog.ts', catalogContent, 'autocode', 'catalog has autocode endpoint');
assertContains('src/spec/catalog.ts', catalogContent, '/offline/mms/search', 'catalog documents the keyless search endpoint');
assertContains('src/spec/catalog.ts', catalogContent, 'icdcdn.who.int', 'catalog names the keyless WHO release file');
assertContains('src/spec/catalog.ts', catalogContent, 'clinicaltables.nlm.nih.gov', 'catalog names the NLM mirror');
assertContains('src/spec/catalog.ts', catalogContent, 'KEYLESS TIER LOSES', 'catalog states what the keyless tier drops');
assertContains('src/spec/catalog.ts', catalogContent, '2026-01', 'catalog points examples at the current release');
assertContains('src/spec/catalog.ts', catalogContent, "119724091 = 'Type 2 diabetes mellitus'", 'catalog labels entity 119724091 as Type 2 diabetes mellitus');
assertNotContains('src/spec/catalog.ts', catalogContent, '1435254666 for Type 2 diabetes', 'catalog no longer mislabels entity 1435254666');

// Verify the keyless tier is wired, sourced and gated
const offlineContent = readFile('src/lib/offline-release.ts');
assertContains('src/lib/offline-release.ts', offlineContent, 'https://icdcdn.who.int/static/releasefiles', 'offline tier reads WHO first-party release files');
const zipContent = readFile('src/lib/zip.ts');
assertContains('src/lib/zip.ts', zipContent, 'deflate-raw', 'zip reader inflates the release archive');
const nlmContent = readFile('src/lib/nlm.ts');
assertContains('src/lib/nlm.ts', nlmContent, 'clinicaltables.nlm.nih.gov/api/icd11_codes/v3', 'NLM adapter targets the keyless ICD-11 index');
assertContains('src/lib/api-adapter.ts', adapterContent, 'keyless_offline', 'keyless results are labelled with their tier');
assertContains('src/lib/api-adapter.ts', adapterContent, 'credentialError', 'a missing credential raises an error');
assertContains('src/lib/api-adapter.ts', adapterContent, 'icdcdn.who.int', 'keyless provenance names its own source');
const doContent2 = readFile('src/do.ts');
assertContains('src/do.ts', doContent2, 'mms_rows', 'DO stages keyless rows into their own table');

// Verify code-mode.ts
const codeModeContent = readFile('src/tools/code-mode.ts');
assertContains('src/tools/code-mode.ts', codeModeContent, 'createSearchTool', 'code-mode uses createSearchTool');
assertContains('src/tools/code-mode.ts', codeModeContent, 'createExecuteTool', 'code-mode uses createExecuteTool');
assertContains('src/tools/code-mode.ts', codeModeContent, 'icd11', 'code-mode uses icd11 prefix');

console.log(`\n${BLUE}📊 Test Results Summary${RESET}`);
console.log(`Total tests: ${totalTests}`);
console.log(`${GREEN}Passed: ${passedTests}${RESET}`);
console.log(`${RED}Failed: ${failedTests}${RESET}`);

if (failedTests > 0) {
  console.log(`\n${RED}❌ Regression tests failed.${RESET}`);
  process.exit(1);
}

console.log(`\n${GREEN}✅ WHO ICD-11 structured content regression tests passed.${RESET}`);
