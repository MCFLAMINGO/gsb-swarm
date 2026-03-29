const fs = require('fs');
const path = require('path');

const acpDistPath = path.join(__dirname, 'node_modules', '@virtuals-protocol', 'acp-node', 'dist', 'index.js');

if (!fs.existsSync(acpDistPath)) {
  console.log('[patch-acp] ACP dist not found, skipping patch.');
  process.exit(0);
}

let content = fs.readFileSync(acpDistPath, 'utf8');

if (content.includes('// PATCHED BY GSB')) {
  console.log('[patch-acp] Already patched, skipping.');
  process.exit(0);
}

const original = 'var import_infra = require("@account-kit/infra");';
const replacement = '// PATCHED BY GSB\nvar import_infra = require("viem/chains");';

if (!content.includes(original)) {
  console.log('[patch-acp] Target line not found, skipping.');
  process.exit(0);
}

content = content.replace(original, replacement);
fs.writeFileSync(acpDistPath, content, 'utf8');
console.log('[patch-acp] Patched successfully.');
