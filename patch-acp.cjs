const fs = require('fs');
const path = require('path');

const acpDistPath = path.join(process.cwd(), 'node_modules', '@virtuals-protocol', 'acp-node', 'dist', 'index.js');

if (!fs.existsSync(acpDistPath)) {
  console.log('[patch-acp] ACP dist not found, skipping.');
  process.exit(0);
}

let content = fs.readFileSync(acpDistPath, 'utf8');

// Remove any previous patch markers so we always re-apply cleanly
content = content.replace(/\/\/ PATCHED BY GSB - START[\s\S]*?\/\/ PATCHED BY GSB - END\n/g, '');
content = content.replace('// PATCHED BY GSB\n', '');

// Fix 1: @account-kit/infra -> viem/chains (chain definitions)
content = content.replace(
  'var import_infra = require("@account-kit/infra");',
  '// PATCHED BY GSB - START\nvar import_infra = require("viem/chains");\n// PATCHED BY GSB - END'
);

// Fix 2: @aa-sdk/core first occurrence -> LocalAccountSigner stub using viem
const aaSdkStub = `// PATCHED BY GSB - START
var import_core = { LocalAccountSigner: { privateKeyToAccountSigner: (pk) => { const { privateKeyToAccount } = require('viem/accounts'); const acct = privateKeyToAccount(pk.startsWith('0x') ? pk : '0x'+pk); return { signMessage: async (msg) => acct.signMessage({ message: msg }), getAddress: async () => acct.address, account: acct }; } } };
// PATCHED BY GSB - END`;

// Fix 3: @aa-sdk/core second occurrence -> reuse import_core
const aaSdkStub2 = `// PATCHED BY GSB - START
var import_core2 = import_core;
// PATCHED BY GSB - END`;

content = content.replace('var import_core = require("@aa-sdk/core");', aaSdkStub);
content = content.replace('var import_core2 = require("@aa-sdk/core");', aaSdkStub2);

fs.writeFileSync(acpDistPath, content, 'utf8');
console.log('[patch-acp] All patches applied successfully.');
