// === FILE: claim_fast_bot.js ===

const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
require("dotenv").config();

const PI_HORIZON = 'https://api.mainnet.minepi.com';
const server = new StellarSdk.Server(PI_HORIZON);
StellarSdk.Networks.PUBLIC;

const CLAIM_MNEMONIC = process.env.CLAIM_MNEMONIC;
const SPONSOR_MNEMONIC = process.env.SPONSOR_MNEMONIC;
const TARGET_ADDRESS = process.env.TARGET_ADDRESS;

(async () => {
  const claimKey = await getKeypairFromMnemonic(CLAIM_MNEMONIC);
  const sponsorKey = await getKeypairFromMnemonic(SPONSOR_MNEMONIC);

  console.log(`\u{1F680} Bot dimulai. Akun: ${claimKey.publicKey()}`);

  while (true) {
    try {
      const balances = await getClaimableBalances(claimKey.publicKey());

      for (const balance of balances) {
        if (!isClaimableNow(balance.claimants, claimKey.publicKey())) continue;

        try {
          const txClaim = await buildClaimTx(balance.id, claimKey, sponsorKey);
          await sendTransaction(txClaim);
          console.log(`\u{2705} Berhasil klaim ${balance.amount} PI`);

          const txTransfer = await buildTransferTx(claimKey, sponsorKey, TARGET_ADDRESS);
          await sendTransaction(txTransfer);
          console.log(`\u{1F4E6} Transfer ${TARGET_ADDRESS} sukses`);
        } catch (err) {
          if (err.response?.data?.extras?.result_codes?.operations?.includes("op_claimable_balance_claimant_invalid")) {
            console.warn("\u{26A0}\u{FE0F} Gagal klaim: Sudah diklaim bot lain");
          } else {
            console.error("\u{274C} Error klaim/transfer:", err.message);
          }
        }
      }
    } catch (err) {
      console.error("\u{1F310} Gagal ambil saldo:", err.message);
    }
  }
})();

// === Helper functions ===

async function getKeypairFromMnemonic(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error("Mnemonic tidak valid!");
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const derived = ed25519.derivePath("m/44'/314159'/0'", seed).key;
  return StellarSdk.Keypair.fromRawEd25519Seed(derived);
}

async function getClaimableBalances(address) {
  const res = await axios.get(`${PI_HORIZON}/claimable_balances?claimant=${address}&limit=200&order=asc`);
  return res.data._embedded?.records || [];
}

function isClaimableNow(claimants, address) {
  const me = claimants.find(c => c.destination === address);
  if (!me) return false;
  const now = Math.floor(Date.now() / 1000);
  const notBefore = me?.predicate?.not?.abs_before_epoch;
  return !notBefore || now > parseInt(notBefore);
}

async function buildClaimTx(balanceId, claimKey, sponsorKey) {
  const account = await server.loadAccount(claimKey.publicKey());
  const fee = await server.fetchBaseFee();

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee,
    networkPassphrase: StellarSdk.Networks.PUBLIC,
    feeAccount: sponsorKey.publicKey()
  })
    .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(60)
    .build();

  tx.sign(claimKey);
  tx.sign(sponsorKey);
  return tx;
}

async function buildTransferTx(fromKey, sponsorKey, toAddress) {
  const account = await server.loadAccount(fromKey.publicKey());
  const fee = await server.fetchBaseFee();
  const balance = account.balances.find(b => b.asset_type === 'native');
  const available = parseFloat(balance?.balance || 0) - 0.01;

  if (available <= 0) throw new Error("Saldo tidak cukup");

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee,
    networkPassphrase: StellarSdk.Networks.PUBLIC,
    feeAccount: sponsorKey.publicKey()
  })
    .addOperation(StellarSdk.Operation.payment({
      destination: toAddress,
      asset: StellarSdk.Asset.native(),
      amount: available.toFixed(7)
    }))
    .setTimeout(60)
    .build();

  tx.sign(fromKey);
  tx.sign(sponsorKey);
  return tx;
}

async function sendTransaction(tx) {
  return await server.submitTransaction(tx);
}
