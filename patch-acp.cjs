const fs = require('fs');
const path = require('path');

const acpDistPath = path.join(process.cwd(), 'node_modules', '@virtuals-protocol', 'acp-node', 'dist', 'index.js');

if (!fs.existsSync(acpDistPath)) {
  console.log('[patch-acp] ACP dist not found, skipping.');
  process.exit(0);
}

let content = fs.readFileSync(acpDistPath, 'utf8');
let patchCount = 0;

content = content.replace(
  /var (import_\w+)\s*=\s*require\("@account-kit\/infra"\);/g,
  (match, varName) => {
    patchCount++;
    console.log(`[patch-acp] Fixed ${varName} (@account-kit/infra -> viem/chains)`);
    return `var ${varName} = require("viem/chains");`;
  }
);

content = content.replace(
  /var (import_\w+)\s*=\s*require\("@account-kit\/smart-contracts"\);/g,
  (match, varName) => {
    patchCount++;
    console.log(`[patch-acp] Fixed ${varName} (@account-kit/smart-contracts -> stub)`);
    return `var ${varName} = {};`;
  }
);

content = content.replace(
  /var (import_\w+)\s*=\s*require\("@aa-sdk\/core"\);/g,
  (match, varName) => {
    patchCount++;
    console.log(`[patch-acp] Fixed ${varName} (@aa-sdk/core -> LocalAccountSigner stub)`);
    return `var ${varName} = { LocalAccountSigner: { privateKeyToAccountSigner: (pk) => { const { privateKeyToAccount } = require('viem/accounts'); const acct = privateKeyToAccount(pk.startsWith('0x') ? pk : '0x'+pk); return { signMessage: async (msg) => acct.signMessage({ message: msg }), getAddress: async () => acct.address, account: acct }; } } };`;
  }
);

if (patchCount > 0) {
  fs.writeFileSync(acpDistPath, content, 'utf8');
  console.log(`[patch-acp] Done. Applied ${patchCount} fix(es).`);
} else {
  console.log('[patch-acp] No issues found. SDK may already be compatible.');
}
