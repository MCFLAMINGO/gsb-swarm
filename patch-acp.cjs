/**
 * patch-acp.cjs — RESTORE ORIGINAL REQUIRES
 * Unconditionally restores the three ESM requires in the ACP SDK dist.
 * Works whether the old bad patch has run or not.
 * --experimental-require-module (Node 20+) handles the ESM loading natively.
 */
const fs = require('fs');
const path = require('path');

const acpDistPath = path.join(process.cwd(), 'node_modules', '@virtuals-protocol', 'acp-node', 'dist', 'index.js');

if (!fs.existsSync(acpDistPath)) {
  console.log('[patch-acp] ACP dist not found, skipping.');
  process.exit(0);
}

let content = fs.readFileSync(acpDistPath, 'utf8');

// --- RESTORE @account-kit/infra ---
content = content.replace(
  /var (import_infra\d*)\s*=\s*\(\(\)\s*=>\s*\{[\s\S]*?require\(["']viem\/chains["']\)[\s\S]*?\}\)\(\);/g,
  (match, varName) => {
    console.log(`[patch-acp] Restoring ${varName} -> @account-kit/infra`);
    return `var ${varName} = require("@account-kit/infra");`;
  }
);

// --- RESTORE @account-kit/smart-contracts ---
content = content.replace(
  /var (import_smart_contracts\d*)\s*=\s*\{\s*\};/g,
  (match, varName) => {
    console.log(`[patch-acp] Restoring ${varName} -> @account-kit/smart-contracts`);
    return `var ${varName} = require("@account-kit/smart-contracts");`;
  }
);

// --- RESTORE @aa-sdk/core ---
content = content.replace(
  /var (import_core\d*)\s*=\s*\{\s*\n\s*LocalAccountSigner[\s\S]*?\n\};\n/g,
  (match, varName) => {
    console.log(`[patch-acp] Restoring ${varName} -> @aa-sdk/core`);
    return `var ${varName} = require("@aa-sdk/core");\n`;
  }
);

fs.writeFileSync(acpDistPath, content, 'utf8');
console.log('[patch-acp] Done. All requires restored to originals.');
