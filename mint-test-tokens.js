// mint-test-tokens.js
// One-time setup: creates devnet test versions of USDC, EURC, JYPC, WBTC, WETH,
// mints a supply of each to YOUR wallet, and prints the mint addresses to paste
// into the app's TOKEN registry.
//
// Run from the project root (where @solana/kit etc. are installed):
//   node mint-test-tokens.js YOUR_WALLET_ADDRESS
//
// If your app packages aren't in this folder, run it from the `mayu` app folder.

import {
  createSolanaRpc, createSolanaRpcSubscriptions, address, pipe,
  generateKeyPairSigner, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions, signTransactionMessageWithSigners,
  getSignatureFromTransaction, sendAndConfirmTransactionFactory, airdropFactory,
  getMinimumBalanceForRentExemption, lamports,
} from '@solana/kit'
import { getCreateAccountInstruction } from '@solana-program/system'
import {
  TOKEN_PROGRAM_ADDRESS, getMintSize, getInitializeMintInstruction,
  findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction,
  getMintToInstruction,
} from '@solana-program/token'

const RPC_HTTP = 'https://api.devnet.solana.com'
const RPC_WS = 'wss://api.devnet.solana.com'

// symbol -> decimals + how many whole units to mint to your wallet
const TOKENS_TO_MINT = [
  { symbol: 'USDC', decimals: 6, supply: 100_000 },
  { symbol: 'EURC', decimals: 6, supply: 100_000 },
  { symbol: 'JYPC', decimals: 0, supply: 10_000_000 },
  { symbol: 'WBTC', decimals: 8, supply: 10 },
  { symbol: 'WETH', decimals: 8, supply: 100 },
]

const recipientArg = process.argv[2]
if (!recipientArg) {
  console.error('Usage: node mint-test-tokens.js YOUR_WALLET_ADDRESS')
  process.exit(1)
}
const recipient = address(recipientArg)

const rpc = createSolanaRpc(RPC_HTTP)
const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_WS)
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })
const airdrop = airdropFactory({ rpc, rpcSubscriptions })

async function fund(authority) {
  console.log('Requesting devnet SOL for the mint authority...')
  try {
    await airdrop({
      commitment: 'confirmed',
      recipientAddress: authority.address,
      lamports: lamports(1_000_000_000n), // 1 SOL
    })
    console.log('  funded.')
  } catch (e) {
    console.error('  airdrop failed (devnet faucet busy). Try again shortly.')
    throw e
  }
}

async function mintOne(authority, { symbol, decimals, supply }) {
  const mint = await generateKeyPairSigner()
  const space = BigInt(getMintSize())
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send()

  const [ata] = await findAssociatedTokenPda({
    mint: mint.address, owner: recipient, tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })

  const amount = BigInt(supply) * 10n ** BigInt(decimals)

  const instructions = [
    getCreateAccountInstruction({
      payer: authority, newAccount: mint, lamports: rent, space,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMintInstruction({
      mint: mint.address, decimals, mintAuthority: authority.address,
    }),
    getCreateAssociatedTokenIdempotentInstruction({
      payer: authority, ata, owner: recipient, mint: mint.address,
    }),
    getMintToInstruction({
      mint: mint.address, token: ata, mintAuthority: authority, amount,
    }),
  ]

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(authority, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const signed = await signTransactionMessageWithSigners(message)
  await sendAndConfirm(signed, { commitment: 'confirmed' })

  return mint.address
}

async function main() {
  const authority = await generateKeyPairSigner()
  console.log('Mint authority (throwaway):', authority.address)
  await fund(authority)

  const results = {}
  for (const token of TOKENS_TO_MINT) {
    process.stdout.write(`Minting ${token.symbol}... `)
    const mintAddress = await mintOne(authority, token)
    results[token.symbol] = mintAddress
    console.log(mintAddress)
  }

  console.log('\n===== paste these into your TOKENS registry =====\n')
  for (const [symbol, mint] of Object.entries(results)) {
    console.log(`${symbol}: mint '${mint}',`)
  }
  console.log('\nDone. Each token minted its full supply to', recipientArg)
}

main().catch((err) => { console.error(err); process.exit(1) })