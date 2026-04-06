/**
 * GSB Jupiter Referral Account Setup
 * Run ONCE to register your referral account on-chain.
 *
 * Usage (in Railway console or locally):
 *   SOL_PRIVATE_KEY=<bs58-encoded-solana-private-key> node scripts/jup_referral_setup.js
 *
 * Your partner public key (wallet that receives fees):
 *   F7U3MrnsoZ3umLTmH9Wtae6VGhnWQPRj4Z1Vtv2QSRFs
 *
 * After running, copy the printed referralAccount address into Railway env vars:
 *   JUPITER_REFERRAL_ACCOUNT=<printed address>
 *
 * You only need to run this once. The referralAccount is permanent on-chain.
 */

const { Connection, Keypair, PublicKey, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

// Jupiter Ultra Referral Project key (from Jupiter docs)
const JUPITER_PROJECT = new PublicKey('DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc');

// Your GSB fee-receiving wallet
const PARTNER_PUBKEY = new PublicKey('F7U3MrnsoZ3umLTmH9Wtae6VGhnWQPRj4Z1Vtv2QSRFs');

// Mints to create referral token accounts for (SOL + USDC)
const FEE_MINTS = [
  'So11111111111111111111111111111111111111112',  // Wrapped SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
];

async function main() {
  const privateKeyB58 = process.env.SOL_PRIVATE_KEY;
  if (!privateKeyB58) {
    console.error('ERROR: Set SOL_PRIVATE_KEY env var (bs58-encoded Solana private key)');
    console.error('This is the private key for the wallet that will PAY for account creation.');
    console.error('It does NOT have to be the same as the partner/fee wallet.');
    process.exit(1);
  }

  const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(RPC, 'confirmed');

  let wallet;
  try {
    wallet = Keypair.fromSecretKey(bs58.decode(privateKeyB58));
    console.log(`Payer wallet: ${wallet.publicKey.toBase58()}`);
  } catch (e) {
    console.error('ERROR: Invalid SOL_PRIVATE_KEY —', e.message);
    process.exit(1);
  }

  // Dynamically require referral SDK (installed at runtime via nixpacks)
  let ReferralProvider;
  try {
    ({ ReferralProvider } = require('@jup-ag/referral-sdk'));
  } catch (e) {
    console.error('ERROR: @jup-ag/referral-sdk not installed. Run: npm install @jup-ag/referral-sdk @solana/web3.js bs58');
    process.exit(1);
  }

  const provider = new ReferralProvider(connection);

  // ── Step 1: Create referralAccount ──────────────────────────────────────────
  console.log('\n[1/3] Creating referralAccount...');
  let referralAccountPubKey;
  try {
    const { tx, referralAccountPubKey: raPK } = await provider.initializeReferralAccountWithName({
      payerPubKey:   wallet.publicKey,
      partnerPubKey: PARTNER_PUBKEY,
      projectPubKey: JUPITER_PROJECT,
      name: 'GSBSwarm',
    });
    referralAccountPubKey = raPK;
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log(`  ✅ referralAccount created: ${referralAccountPubKey.toBase58()}`);
    console.log(`  Tx: https://solscan.io/tx/${sig}`);
  } catch (e) {
    if (e.message?.includes('already in use') || e.message?.includes('custom program error: 0x0')) {
      console.log('  ℹ️  referralAccount may already exist — continuing to token account setup');
      // Derive it manually
      const [derived] = PublicKey.findProgramAddressSync(
        [Buffer.from('referral'), JUPITER_PROJECT.toBuffer(), PARTNER_PUBKEY.toBuffer()],
        new PublicKey('REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3') // Referral program
      );
      referralAccountPubKey = derived;
      console.log(`  Derived referralAccount: ${referralAccountPubKey.toBase58()}`);
    } else {
      console.error('  ERROR creating referralAccount:', e.message);
      process.exit(1);
    }
  }

  // ── Step 2: Create referralTokenAccounts for SOL and USDC ───────────────────
  console.log('\n[2/3] Creating referralTokenAccounts for fee mints...');
  for (const mintAddress of FEE_MINTS) {
    const mint = new PublicKey(mintAddress);
    try {
      const { tx, tokenAccount } = await provider.initializeReferralTokenAccountV2({
        payerPubKey:          wallet.publicKey,
        referralAccountPubKey,
        mint,
      });
      const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
      const symbol = mintAddress.startsWith('So11') ? 'SOL' : 'USDC';
      console.log(`  ✅ ${symbol} token account: ${tokenAccount.toBase58()}`);
      console.log(`     Tx: https://solscan.io/tx/${sig}`);
    } catch (e) {
      if (e.message?.includes('already in use')) {
        console.log(`  ℹ️  Token account for ${mintAddress.slice(0,8)}... already exists`);
      } else {
        console.error(`  WARN: Could not create token account for ${mintAddress}:`, e.message);
      }
    }
  }

  // ── Step 3: Print summary ────────────────────────────────────────────────────
  console.log('\n[3/3] DONE — add this to Railway env vars:');
  console.log('──────────────────────────────────────────');
  console.log(`JUPITER_REFERRAL_ACCOUNT=${referralAccountPubKey.toBase58()}`);
  console.log('──────────────────────────────────────────');
  console.log('\nView your referral dashboard:');
  console.log('  https://referral.jup.ag/');
  console.log('\nFees are collected in SOL and/or USDC on-chain.');
  console.log('Jupiter takes 20% of your referral fee; you keep 80%.');
  console.log('At 50 bps referral fee: you earn 40 bps per Solana swap.');
}

main().catch(e => { console.error(e); process.exit(1); });
