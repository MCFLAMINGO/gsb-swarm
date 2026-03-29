const fs = require('fs');
const path = require('path');

const acpDistPath = path.join(process.cwd(), 'node_modules', '@virtuals-protocol', 'acp-node', 'dist', 'index.js');

if (!fs.existsSync(acpDistPath)) {
  console.log('[patch-acp] ACP dist not found, skipping.');
  process.exit(0);
}

let content = fs.readFileSync(acpDistPath, 'utf8');

// Always rewrite both lines regardless of current state
// Fix 1: replace whatever is assigned to import_infra with viem/chains
content = content.replace(
  /var import_infra = require\([^)]+\);/,
  'var import_infra = require("viem/chains");'
);

// Fix 2 & 3: replace @aa-sdk/core requires with stubs
const stub = `var import_core = { LocalAccountSigner: { privateKeyToAccountSigner: (pk) => { const { privateKeyToAccount } = require('viem/accounts'); const acct = privateKeyToAccount(pk.startsWith('0x') ? pk : '0x'+pk); return { signMessage: async (msg) => acct.signMessage({ message: msg }), getAddress: async () => acct.address, account: acct }; } } };`;

content = content.replace(/var import_core = require\("[^"]+"\);/, stub);
content = content.replace(/var import_core2 = require\("[^"]+"\);/, 'var import_core2 = import_core;');

fs.writeFileSync(acpDistPath, content, 'utf8');
console.log('[patch-acp] Patches applied.');
