import { useState, useEffect, useRef } from 'react'
import { usePrivy, useLoginWithEmail } from '@privy-io/react-auth'
import { useWallets, useCreateWallet, useSignAndSendTransaction } from '@privy-io/react-auth/solana'
import {
  createSolanaRpc, address, pipe, generateKeyPairSigner, createNoopSigner,
  createTransactionMessage, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  partiallySignTransactionMessageWithSigners, getTransactionEncoder, getBase58Decoder,
  createKeyPairSignerFromPrivateKeyBytes,
} from '@solana/kit'
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system'
import {
  TOKEN_PROGRAM_ADDRESS, getMintSize, getInitializeMintInstruction,
  findAssociatedTokenPda, getCreateAssociatedTokenInstruction, getMintToInstruction,
  getCreateAssociatedTokenIdempotentInstruction, getTransferInstruction,
} from '@solana-program/token'

const rpc = createSolanaRpc('https://api.devnet.solana.com')
const MAYU_MINT = address('FXpWnihk17THTFfwt4kQaX4xMhTetSwzZmSTjNhEwpAT')


function getQuote(amountIn, reserveIn, reserveOut) {
  const k = reserveIn * reserveOut
  const newReserveIn = reserveIn + amountIn
  const newReserveOut = k / newReserveIn
  return reserveOut - newReserveOut
}

function App() {
  const { ready, authenticated, user, logout } = usePrivy()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const { sendCode, loginWithCode } = useLoginWithEmail()
  const { ready: walletsReady, wallets } = useWallets()
  const { createWallet } = useCreateWallet()
  const solanaAccount = user?.linkedAccounts?.find(
    (account) => account.type === 'wallet' && account.chainType === 'solana'
  )
  const creatingRef = useRef(false)
  const [balance, setBalance] = useState(null)
  const [refresh, setRefresh] = useState(0)
  const { signAndSendTransaction } = useSignAndSendTransaction()
  const [mintAddress, setMintAddress] = useState(null)
  const [swapAmount, setSwapAmount] = useState('')
  const [poolSol, setPoolSol] = useState(null)
  const [poolMayu, setPoolMayu] = useState(null)

  const [pool, setPool] = useState(null)

  useEffect(() => {
    const secret = import.meta.env.VITE_POOL_SECRET
    if (!secret) return
    const bytes = new Uint8Array(secret.match(/.{2}/g).map((h) => parseInt(h, 16)))
    createKeyPairSignerFromPrivateKeyBytes(bytes).then(setPool)
  }, [])

  useEffect(() => {
    if (!pool) return
    const fetchReserves = async () => {
      const { value: lamports } = await rpc.getBalance(pool.address).send()
      setPoolSol(Number(lamports) / 1_000_000_000)
      try {
        const [poolAta] = await findAssociatedTokenPda({
          mint: MAYU_MINT,
          owner: pool.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        })
        const { value } = await rpc.getTokenAccountBalance(poolAta).send()
        setPoolMayu(value.uiAmount)
      } catch {
        setPoolMayu(0)
      }
    }
    fetchReserves()
  }, [pool, refresh])

  useEffect(() => {
    if (!solanaAccount) return
    rpc.getBalance(address(solanaAccount.address))
      .send()
      .then(({ value }) => setBalance(Number(value) / 1_000_000_000))
      .catch((err) => console.error('balance fetch failed:', err))
  }, [solanaAccount, refresh])

  useEffect(() => {
    if (!authenticated || !walletsReady || solanaAccount || creatingRef.current) return
    creatingRef.current = true
    createWallet()
      .then(({ wallet }) => console.log('auto-created:', wallet))
      .catch((err) => console.error('auto-create failed:', err))
  }, [authenticated, walletsReady, solanaAccount])

  const mintMayu = async () => {
    try {
      const owner = address(solanaAccount.address)
      const ownerSigner = createNoopSigner(owner)
      const mint = await generateKeyPairSigner()

      const space = BigInt(getMintSize())
      const rent = await rpc
        .getMinimumBalanceForRentExemption(space)
        .send()

      const [ata] = await findAssociatedTokenPda({
        mint: mint.address,
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })

      const instructions = [
        getCreateAccountInstruction({
          payer: ownerSigner,
          newAccount: mint,
          lamports: rent,
          space,
          programAddress: TOKEN_PROGRAM_ADDRESS,
        }),
        getInitializeMintInstruction({
          mint: mint.address,
          decimals: 9,
          mintAuthority: owner,
        }),
        getCreateAssociatedTokenInstruction({
          payer: ownerSigner,
          ata,
          owner,
          mint: mint.address,
        }),
        getMintToInstruction({
          mint: mint.address,
          token: ata,
          mintAuthority: ownerSigner,
          amount: 1_000_000n * 10n ** 9n,
        }),
      ]

      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()

      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(ownerSigner, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      )

      const partiallySigned = await partiallySignTransactionMessageWithSigners(message)
      const txBytes = getTransactionEncoder().encode(partiallySigned)

      const { signature } = await signAndSendTransaction({
        transaction: new Uint8Array(txBytes),
        wallet: wallets[0],
        chain: 'solana:devnet',
      })

      console.log('Mayu minted! signature:', getBase58Decoder().decode(signature))
      setMintAddress(mint.address)
      setTimeout(() => setRefresh((n) => n + 1), 2000)
    } catch (err) {
      console.error('mint failed:', err)
    }
  }

  const [mayuBalance, setMayuBalance] = useState(null)

  useEffect(() => {
    if (!solanaAccount) return
    const fetchMayu = async () => {
      try {
        const [ata] = await findAssociatedTokenPda({
          mint: MAYU_MINT,
          owner: address(solanaAccount.address),
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        })
        const { value } = await rpc.getTokenAccountBalance(ata).send()
        setMayuBalance(value.uiAmount)
      } catch (err) {
        setMayuBalance(0)
      }
    }
    fetchMayu()
  }, [solanaAccount, refresh])

  const seedPool = async () => {
    try {
      const owner = address(solanaAccount.address)
      const ownerSigner = createNoopSigner(owner)

      const [userAta] = await findAssociatedTokenPda({
        mint: MAYU_MINT, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
      const [poolAta] = await findAssociatedTokenPda({
        mint: MAYU_MINT, owner: pool.address, tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })

      const instructions = [
        getTransferSolInstruction({
          source: ownerSigner,
          destination: pool.address,
          amount: 2_000_000n,
        }),
        getCreateAssociatedTokenIdempotentInstruction({
          payer: ownerSigner,
          ata: poolAta,
          owner: pool.address,
          mint: MAYU_MINT,
        }),
        getTransferInstruction({
          source: userAta,
          destination: poolAta,
          authority: ownerSigner,
          amount: 16_534_000_000n,
        }),
      ]

      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(ownerSigner, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      )
      const partiallySigned = await partiallySignTransactionMessageWithSigners(message)
      const txBytes = getTransactionEncoder().encode(partiallySigned)

      await signAndSendTransaction({
        transaction: new Uint8Array(txBytes),
        wallet: wallets[0],
        chain: 'solana:devnet',
      })

      console.log('pool seeded!')
      setTimeout(() => setRefresh((n) => n + 1), 2000)
    } catch (err) {
      console.error('seed failed:', err)
    }
  }

  const executeSwap = async () => {
    try {
      if (!pool || !poolSol || !poolMayu) return
      const amountIn = Number(swapAmount)
      if (!amountIn || amountIn <= 0) return

      const owner = address(solanaAccount.address)
      const ownerSigner = createNoopSigner(owner)

      const lamportsIn = BigInt(Math.round(amountIn * 1_000_000_000))
      const mayuOut = getQuote(amountIn, poolSol, poolMayu)
      const mayuOutBase = BigInt(Math.floor(mayuOut * 1_000_000_000))

      const [userAta] = await findAssociatedTokenPda({
        mint: MAYU_MINT, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
      const [poolAta] = await findAssociatedTokenPda({
        mint: MAYU_MINT, owner: pool.address, tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })

      const instructions = [
        getTransferSolInstruction({
          source: ownerSigner,
          destination: pool.address,
          amount: lamportsIn,
        }),
        getTransferInstruction({
          source: poolAta,
          destination: userAta,
          authority: pool,
          amount: mayuOutBase,
        }),
      ]

      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(ownerSigner, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      )
      const partiallySigned = await partiallySignTransactionMessageWithSigners(message)
      const txBytes = getTransactionEncoder().encode(partiallySigned)

      await signAndSendTransaction({
        transaction: new Uint8Array(txBytes),
        wallet: wallets[0],
        chain: 'solana:devnet',
      })

      console.log(`swapped ${amountIn} SOL for ${mayuOut} MAYU`)
      setSwapAmount('')
      setTimeout(() => setRefresh((n) => n + 1), 2000)
    } catch (err) {
      console.error('swap failed:', err)
    }
  }

  if (!ready) return <p>Loading...</p>

  if (authenticated) {
    return (
      <div>
        <h1>Welcome to Mayu</h1>
        <p>Your Solana wallet:</p>
        <p>{solanaAccount?.address ?? 'Creating your wallet...'}</p>
        <p>Balance: {balance === null ? 'loading...' : `${balance} SOL`}</p>
        <p>Balance: {mayuBalance === null ? 'loading...' : `${mayuBalance} MAYU`}</p>
        <h2>Swap</h2>
        <input
          placeholder="SOL amount"
          value={swapAmount}
          onChange={(e) => setSwapAmount(e.target.value)}
        />
        <p>
          {poolSol > 0 && poolMayu > 0 && swapAmount > 0
            ? `≈ ${getQuote(Number(swapAmount), poolSol, poolMayu).toFixed(2)} MAYU`
            : 'Pool is empty'}
        </p>
        <p>Pool: {poolSol ?? '...'} SOL / {poolMayu ?? '...'} MAYU</p>
        <button
          onClick={async () => {
            try {
              await rpc
                .requestAirdrop(address(solanaAccount.address), 1_000_000_000n)
                .send()
              setTimeout(() => setRefresh((n) => n + 1), 2000)
            } catch (err) {
              console.error('airdrop failed:', err)
            }
          }}
        >
          Get 1 devnet SOL
        </button>
        <button onClick={() => setRefresh((n) => n + 1)}>Refresh balance</button>
        <button onClick={seedPool}>Seed pool</button>
        <button onClick={executeSwap}>Swap</button>
        <button onClick={logout}>Log out</button>
      </div>
    )
  }

  return (
    <div>
      <h1>Mayu</h1>
      <input
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button onClick={() => sendCode({ email })}>Send code</button>
      <input
        placeholder="Code from email"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <button onClick={() => loginWithCode({ code })}>Log in</button>
    </div>
  )
}

export default App