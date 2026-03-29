const fs = require('fs');
const path = require('path');

const acpDistPath = path.join(process.cwd(), 'node_modules', '@virtuals-protocol', 'acp-node', 'dist', 'index.js');

if (!fs.existsSync(acpDistPath)) {
  console.log('[patch-acp] ACP dist not found, skipping.');
  process.exit(0);
}

let content = fs.readFileSync(acpDistPath, 'utf8');
let patchCount = 0;

// @account-kit/infra stub: chain definitions + alchemy() transport factory
content = content.replace(
  /var (import_\w+)\s*=\s*require\("@account-kit\/infra"\);/g,
  (match, varName) => {
    patchCount++;
    console.log(`[patch-acp] Stubbing ${varName} (@account-kit/infra)`);
    return `var ${varName} = (() => {
  const viemChains = require("viem/chains");
  const { http } = require("viem");
  const alchemy = (opts) => http(opts && opts.rpcUrl ? opts.rpcUrl : undefined);
  return { ...viemChains, alchemy };
})();`;
  }
);

// @account-kit/smart-contracts stub
content = content.replace(
  /var (import_\w+)\s*=\s*require\("@account-kit\/smart-contracts"\);/g,
  (match, varName) => {
    patchCount++;
    console.log(`[patch-acp] Stubbing ${varName} (@account-kit/smart-contracts)`);
    return `var ${varName} = {};`;
  }
);

// @aa-sdk/core stub with LocalAccountSigner
content = content.replace(
  /var (import_\w+)\s*=\s*require\("@aa-sdk\/core"\);/g,
  (match, varName) => {
    patchCount++;
    console.log(`[patch-acp] Stubbing ${varName} (@aa-sdk/core)`);
    return `var ${varName} = {
  LocalAccountSigner: {
    privateKeyToAccountSigner: (pk) => {
      const { privateKeyToAccount } = require('viem/accounts');
      const key = pk.startsWith('0x') ? pk : ('0x' + pk);
      const acct = privateKeyToAccount(key);
      return {
        signMessage: async (msg) => acct.signMessage({ message: msg }),
        getAddress: async () => acct.address,
        account: acct
      };
    }
  }
};`;
  }
);

if (patchCount > 0) {
  fs.writeFileSync(acpDistPath, content, 'utf8');
  console.log(`[patch-acp] Done. Applied ${patchCount} fix(es).`);
} else {
  console.log('[patch-acp] No ESM require() issues found. SDK may already be compatible.');
}
