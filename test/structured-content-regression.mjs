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

function readFile(relPath) {
  const absPath = path.resolve(SERVER_ROOT, relPath);
  return fs.readFileSync(absPath, 'utf8');
}

console.log(`${BLUE}🧪 WHO ICD-11 Structured Content Regression Tests${RESET}`);

// Verify index.ts structure
const indexContent = readFile('src/index.ts');
assertContains('src/index.ts', indexContent, 'Icd11DataDO', 'index.ts exports Icd11DataDO');
assertContains('src/index.ts', indexContent, 'McpAgent', 'index.ts uses McpAgent');
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
