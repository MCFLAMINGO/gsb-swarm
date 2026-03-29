const fs = require('fs');
const path = require('path');

const acpDistPath = path.join(process.cwd(), 'node_modules', '@virtuals-protocol', 'acp-node', 'dist', 'index.js');

if (!fs.existsSync(acpDistPath)) {
  console.log('[patch-acp] ACP dist not found, skipping.');
  process.exit(0);
}

let content = fs.readFileSync(acpDistPath, 'utf8');

// Remove old patch marker so we re-apply cleanly
content = content.replace('// PATCHED BY GSB\n', '');

let patched = false;

// Fix 1: @account-kit/infra -> viem/chains
if (content.includes('var import_infra = require("@account-kit/infra");')) {
  content = content.replace(
    'var import_infra = require("@account-kit/infra");',
    'var import_infra = require("viem/chains");'
  );
  console.log('[patch-acp] Fixed @account-kit/infra');
  patched = true;
}

// Fix 2: @aa-sdk/core -> stub
if (content.includes('var import_aa_sdk_core = require("@aa-sdk/core");')) {
  content = content.replace(
    'var import_aa_sdk_core = require("@aa-sdk/core");',
    'var import_aa_sdk_core = {};'
  );
  console.log('[patch-acp] Fixed @aa-sdk/core');
  patched = true;
}

if (patched) {
  content = '// PATCHED BY GSB\n' + content;
  fs.writeFileSync(acpDistPath, content, 'utf8');
  console.log('[patch-acp] All patches applied successfully.');
} else {
  console.log('[patch-acp] Nothing to patch.');
}
