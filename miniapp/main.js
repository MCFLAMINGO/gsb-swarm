// miniapp/main.js
const API_BASE = "https://gsb-swarm-production.up.railway.app";
let userId = null;
let walletAddress = null;
let phantomSession = null;
let phantomSharedSecret = null;
let isTelegram = !!window.Telegram?.WebApp;

if (isTelegram) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
  userId = window.Telegram.WebApp.initDataUnsafe?.user?.id;
}

// ==================== KEYPAIR (persisted across redirects) ====================
function getDappKeyPair() {
  const stored = sessionStorage.getItem('gsb_dapp_kp');
  if (stored) {
    const parsed = JSON.parse(stored);
    return {
      publicKey: new Uint8Array(parsed.publicKey),
      secretKey: new Uint8Array(parsed.secretKey)
    };
  }
  const kp = nacl.box.keyPair();
  sessionStorage.setItem('gsb_dapp_kp', JSON.stringify({
    publicKey: Array.from(kp.publicKey),
    secretKey: Array.from(kp.secretKey)
  }));
  return kp;
}

function loadPhantomSession() {
  const stored = sessionStorage.getItem('gsb_phantom_session');
  if (stored) {
    const parsed = JSON.parse(stored);
    phantomSession = parsed.session;
    phantomSharedSecret = new Uint8Array(parsed.sharedSecret);
    walletAddress = parsed.walletAddress;
  }
}

function savePhantomSession(session, sharedSecret, address) {
  sessionStorage.setItem('gsb_phantom_session', JSON.stringify({
    session,
    sharedSecret: Array.from(sharedSecret),
    walletAddress: address
  }));
}

// ==================== CONNECT WALLET ====================
document.getElementById('connect-btn').addEventListener('click', () => {
  const keyPair = getDappKeyPair();
  const pubkey = bs58.encode(keyPair.publicKey);
  const redirect = encodeURIComponent(`${window.location.origin}/miniapp/?connected=1&userId=${userId}`);

  const url = `https://phantom.app/ul/v1/connect` +
    `?dapp_encryption_public_key=${encodeURIComponent(pubkey)}` +
    `&redirect_link=${redirect}` +
    `&app_url=${encodeURIComponent(window.location.origin)}` +
    `&cluster=mainnet-beta`;

  if (isTelegram) Telegram.WebApp.openLink(url);
  else window.open(url, '_blank');
});

// ==================== HANDLE PHANTOM CONNECT RESPONSE ====================
window.addEventListener('load', () => {
  // Restore any existing session first
  loadPhantomSession();

  const params = new URLSearchParams(window.location.search);

  if (params.get('connected') === '1') {
    handlePhantomConnectResponse(params);
  } else if (params.get('swapDone') === '1') {
    showStatus('Swap submitted successfully.', 'success');
  }

  // If session already exists, restore UI
  if (walletAddress) {
    document.getElementById('wallet-status').innerHTML =
      `Connected: <span style="font-family:monospace">${walletAddress.slice(0,6)}...${walletAddress.slice(-4)}</span>`;
    document.getElementById('swap-btn').disabled = false;
  }
});

async function handlePhantomConnectResponse(params) {
  try {
    const phantomPubkeyB58 = params.get('phantom_encryption_public_key');
    const dataB58 = params.get('data');
    const nonceB58 = params.get('nonce');

    if (!phantomPubkeyB58 || !dataB58 || !nonceB58) {
      showStatus('Invalid connect response from Phantom.', 'error');
      return;
    }

    const keyPair = getDappKeyPair();
    const sharedSecret = nacl.box.before(
      bs58.decode(phantomPubkeyB58),
      keyPair.secretKey
    );

    const decrypted = nacl.box.open.after(
      bs58.decode(dataB58),
      bs58.decode(nonceB58),
      sharedSecret
    );

    if (!decrypted) throw new Error('Decryption failed');

    const payload = JSON.parse(new TextDecoder().decode(decrypted));

    walletAddress = payload.public_key;
    phantomSession = payload.session;
    phantomSharedSecret = sharedSecret;

    savePhantomSession(phantomSession, sharedSecret, walletAddress);

    document.getElementById('wallet-status').innerHTML =
      `Connected: <span style="font-family:monospace">${walletAddress.slice(0,6)}...${walletAddress.slice(-4)}</span>`;
    document.getElementById('swap-btn').disabled = false;

    // Save wallet to backend
    await fetch(`${API_BASE}/api/user/set-wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, walletAddress, chain: 'solana' })
    });

    showStatus('Wallet connected.', 'success');

    // Fire any pending swap
    const pendingSwap = sessionStorage.getItem('gsb_pending_swap');
    if (pendingSwap) {
      sessionStorage.removeItem('gsb_pending_swap');
      const { serializedTx } = JSON.parse(pendingSwap);
      await executeSolanaSignAndSend(serializedTx);
    }

  } catch (e) {
    console.error(e);
    showStatus('Failed to connect wallet.', 'error');
  }
}

// ==================== SWAP EXECUTION ====================
document.getElementById('swap-btn').addEventListener('click', async () => {
  const chain = document.getElementById('chain').value;
  const tokenOut = document.getElementById('token-out').value.trim();
  const amount = parseFloat(document.getElementById('amount').value);

  if (!tokenOut || isNaN(amount) || amount <= 0) {
    showStatus('Enter a token and amount.', 'error');
    return;
  }

  const btn = document.getElementById('swap-btn');
  btn.disabled = true;
  btn.textContent = 'Preparing Swap...';
  showStatus('Fetching swap route...', 'info');

  try {
    const res = await fetch(`${API_BASE}/api/swap/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        walletAddress,
        chain,
        tokenIn: 'USDC',
        tokenOut,
        amount,
        slippage: 1.5
      })
    });

    const data = await res.json();

    if (chain === 'solana' && data.transaction) {
      // Solana: sign via Phantom deeplink
      await executeSolanaSignAndSend(data.transaction);
    } else if (data.uniswapUrl || data.txUrl) {
      // EVM: open Uniswap / Tempo DEX
      const url = data.uniswapUrl || data.txUrl;
      if (isTelegram) Telegram.WebApp.openLink(url);
      else window.open(url, '_blank');
      showStatus('Opening swap...', 'success');
    } else {
      showStatus(data.error || 'Swap failed — no route returned.', 'error');
    }
  } catch (e) {
    console.error(e);
    showStatus('Network error. Try again.', 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Swap Now';
});

// ==================== SOLANA SIGN + SEND (Phantom deeplink) ====================
async function executeSolanaSignAndSend(serializedTx) {
  // If no session yet, connect first and store pending swap
  if (!phantomSession || !phantomSharedSecret) {
    sessionStorage.setItem('gsb_pending_swap', JSON.stringify({ serializedTx }));
    document.getElementById('connect-btn').click();
    return;
  }

  try {
    const keyPair = getDappKeyPair();
    const nonce = nacl.randomBytes(24);

    const payload = {
      transaction: serializedTx, // base58-encoded from backend
      session: phantomSession,
      sendOptions: { skipPreflight: false, maxRetries: 3 }
    };

    const encryptedPayload = nacl.box.after(
      new TextEncoder().encode(JSON.stringify(payload)),
      nonce,
      phantomSharedSecret
    );

    const redirect = encodeURIComponent(
      `${window.location.origin}/miniapp/?swapDone=1&userId=${userId}`
    );

    const signUrl = `https://phantom.app/ul/v1/signAndSendTransaction` +
      `?dapp_encryption_public_key=${bs58.encode(keyPair.publicKey)}` +
      `&nonce=${bs58.encode(nonce)}` +
      `&redirect_link=${redirect}` +
      `&payload=${bs58.encode(encryptedPayload)}`;

    if (isTelegram) Telegram.WebApp.openLink(signUrl);
    else window.open(signUrl, '_blank');

    showStatus('Opening Phantom to sign...', 'info');
  } catch (e) {
    console.error(e);
    showStatus('Failed to build sign request.', 'error');
  }
}

// ==================== HELPERS ====================
function showStatus(message, type = 'info') {
  const el = document.getElementById('status');
  el.textContent = message;
  el.style.background =
    type === 'success' ? '#052e16' :
    type === 'error'   ? '#450a0a' :
    '#1c1c27';
}
