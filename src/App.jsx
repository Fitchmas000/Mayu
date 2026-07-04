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

// Demo conversion rate for display only. Devnet SOL has no real dollar
// price; this makes the UI show dollar-first values like the mockup.
const SOL_USD = 82.67
const SLIPPAGE = 0.005 // 0.5%

function getQuote(amountIn, reserveIn, reserveOut) {
  const k = reserveIn * reserveOut
  const newReserveIn = reserveIn + amountIn
  const newReserveOut = k / newReserveIn
  return reserveOut - newReserveOut
}

const usd = (n) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

function App() {
  const { ready, authenticated, user, logout } = usePrivy()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const { sendCode, loginWithCode } = useLoginWithEmail()
  const { ready: walletsReady, wallets } = useWallets()
  const { createWallet } = useCreateWallet()
  const { signAndSendTransaction } = useSignAndSendTransaction()

  const solanaAccount = user?.linkedAccounts?.find(
    (account) => account.type === 'wallet' && account.chainType === 'solana'
  )

  const creatingRef = useRef(false)
  const [refresh, setRefresh] = useState(0)
  const [balance, setBalance] = useState(null)
  const [mayuBalance, setMayuBalance] = useState(null)
  const [pool, setPool] = useState(null)
  const [poolSol, setPoolSol] = useState(null)
  const [poolMayu, setPoolMayu] = useState(null)

  // UI state
  const [view, setView] = useState('home') // 'home' | 'swap' | 'confirm' | 'receive'
  const [swapAmount, setSwapAmount] = useState('')
  const [pendingSwap, setPendingSwap] = useState(null)
  const [status, setStatus] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [lastSwap, setLastSwap] = useState(null)

  // ----- load the pool signer from env -----
  useEffect(() => {
    const secret = import.meta.env.VITE_POOL_SECRET
    if (!secret) return
    const bytes = new Uint8Array(secret.match(/.{2}/g).map((h) => parseInt(h, 16)))
    createKeyPairSignerFromPrivateKeyBytes(bytes).then(setPool)
  }, [])

  // ----- pool reserves -----
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

  // ----- user SOL balance -----
  useEffect(() => {
    if (!solanaAccount) return
    rpc.getBalance(address(solanaAccount.address))
      .send()
      .then(({ value }) => setBalance(Number(value) / 1_000_000_000))
      .catch((err) => console.error('balance fetch failed:', err))
  }, [solanaAccount, refresh])

  // ----- user MAYU balance -----
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
      } catch {
        setMayuBalance(0)
      }
    }
    fetchMayu()
  }, [solanaAccount, refresh])

  // ----- auto-create wallet on first login -----
  useEffect(() => {
    if (!authenticated || !walletsReady || solanaAccount || creatingRef.current) return
    creatingRef.current = true
    createWallet()
      .then(({ wallet }) => console.log('auto-created:', wallet))
      .catch((err) => console.error('auto-create failed:', err))
  }, [authenticated, walletsReady, solanaAccount])

  // ----- derived display numbers -----
  const mayuUsd = poolSol > 0 && poolMayu > 0 ? (poolSol / poolMayu) * SOL_USD : 0
  const totalUsd = (balance ?? 0) * SOL_USD + (mayuBalance ?? 0) * mayuUsd

  const amountNum = Number(swapAmount)
  const validAmount =
    swapAmount !== '' && !Number.isNaN(amountNum) && amountNum > 0
  const quote =
    validAmount && poolSol > 0 && poolMayu > 0
      ? getQuote(amountNum, poolSol, poolMayu)
      : 0
  const spotRate = poolSol > 0 && poolMayu > 0 ? poolMayu / poolSol : 0
  const priceImpact =
    validAmount && quote > 0 ? (1 - quote / amountNum / spotRate) * 100 : 0
  const overBalance = validAmount && balance !== null && amountNum > balance

  // ----- transaction ceremony (shared shape) -----
  const sendInstructions = async (instructions) => {
    const owner = address(solanaAccount.address)
    const ownerSigner = createNoopSigner(owner)
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(ownerSigner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    )
    const partiallySigned = await partiallySignTransactionMessageWithSigners(message)
    const txBytes = getTransactionEncoder().encode(partiallySigned)
    return signAndSendTransaction({
      transaction: new Uint8Array(txBytes),
      wallet: wallets[0],
      chain: 'solana:devnet',
    })
  }

  // ----- swap: review step -----
  const reviewSwap = () => {
    if (!validAmount || overBalance || quote <= 0) return
    setPendingSwap({
      solIn: amountNum,
      mayuOut: quote,
      minOut: quote * (1 - SLIPPAGE),
      rate: quote / amountNum,
    })
    setStatus({ text: '', error: false })
    setView('confirm')
  }

  // ----- swap: execute step -----
  const executeSwap = async () => {
    if (!pendingSwap || !pool) return
    setBusy(true)
    setStatus({ text: 'Sending your swap...', error: false })
    try {
      const owner = address(solanaAccount.address)
      const ownerSigner = createNoopSigner(owner)

      const lamportsIn = BigInt(Math.round(pendingSwap.solIn * 1_000_000_000))
      const mayuOutBase = BigInt(Math.floor(pendingSwap.mayuOut * 1_000_000_000))

      const [userAta] = await findAssociatedTokenPda({
        mint: MAYU_MINT, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
      const [poolAta] = await findAssociatedTokenPda({
        mint: MAYU_MINT, owner: pool.address, tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })

      await sendInstructions([
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
      ])

      setLastSwap({ sol: pendingSwap.solIn, mayu: pendingSwap.mayuOut })
      setSwapAmount('')
      setPendingSwap(null)
      setStatus({ text: '', error: false })
      setView('home')
      setTimeout(() => setRefresh((n) => n + 1), 2000)
    } catch (err) {
      console.error('swap failed:', err)
      setStatus({ text: "The swap didn't go through. Nothing was moved.", error: true })
    } finally {
      setBusy(false)
    }
  }

  // ----- dev tools -----
  const airdrop = async () => {
    try {
      await rpc.requestAirdrop(address(solanaAccount.address), 1_000_000_000n).send()
      setTimeout(() => setRefresh((n) => n + 1), 2000)
    } catch (err) {
      console.error('airdrop failed:', err)
    }
  }

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
      await sendInstructions([
        getTransferSolInstruction({
          source: ownerSigner, destination: pool.address, amount: 2_000_000n,
        }),
        getCreateAssociatedTokenIdempotentInstruction({
          payer: ownerSigner, ata: poolAta, owner: pool.address, mint: MAYU_MINT,
        }),
        getTransferInstruction({
          source: userAta, destination: poolAta, authority: ownerSigner,
          amount: 16_534_000_000n,
        }),
      ])
      console.log('pool seeded!')
      setTimeout(() => setRefresh((n) => n + 1), 2000)
    } catch (err) {
      console.error('seed failed:', err)
    }
  }

  // Kept for reference: the transaction that created MAYU. Not wired to
  // any button so it can't fire by accident.
  const mintMayu = async () => {
    try {
      const owner = address(solanaAccount.address)
      const ownerSigner = createNoopSigner(owner)
      const mint = await generateKeyPairSigner()
      const space = BigInt(getMintSize())
      const rent = await rpc.getMinimumBalanceForRentExemption(space).send()
      const [ata] = await findAssociatedTokenPda({
        mint: mint.address, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
      await sendInstructions([
        getCreateAccountInstruction({
          payer: ownerSigner, newAccount: mint, lamports: rent, space,
          programAddress: TOKEN_PROGRAM_ADDRESS,
        }),
        getInitializeMintInstruction({
          mint: mint.address, decimals: 9, mintAuthority: owner,
        }),
        getCreateAssociatedTokenInstruction({
          payer: ownerSigner, ata, owner, mint: mint.address,
        }),
        getMintToInstruction({
          mint: mint.address, token: ata, mintAuthority: ownerSigner,
          amount: 1_000_000n * 10n ** 9n,
        }),
      ])
      console.log('minted new token:', mint.address)
    } catch (err) {
      console.error('mint failed:', err)
    }
  }

  const copyAddress = async () => {
    await navigator.clipboard.writeText(solanaAccount.address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (!ready) return <p className="muted" style={{ textAlign: 'center', paddingTop: '30vh' }}>Loading...</p>

  // ================= LOGIN =================
  if (!authenticated) {
    return (
      <div className="login-wrap">
        <div className="logo">M</div>
        <h1>Mayu</h1>
        <p className="tagline">A wallet that works like a normal app.</p>
        <input
          className="field"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {!codeSent ? (
          <button
            className="btn btn-primary"
            onClick={() => { sendCode({ email }); setCodeSent(true) }}
          >
            Send code
          </button>
        ) : (
          <>
            <input
              className="field"
              placeholder="6-digit code from your email"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button className="btn btn-primary" onClick={() => loginWithCode({ code })}>
              Log in
            </button>
            <button className="btn-ghost" onClick={() => setCodeSent(false)}>
              Use a different email
            </button>
          </>
        )}
      </div>
    )
  }

  // ================= RECEIVE =================
  if (view === 'receive') {
    return (
      <div>
        <div className="screen-header">
          <button className="back-btn" onClick={() => setView('home')}>←</button>
          <h1>Receive</h1>
        </div>
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            Your address on Solana devnet. Anyone can send SOL or MAYU here.
          </p>
          <p className="mono">{solanaAccount?.address}</p>
          <button className="btn" onClick={copyAddress}>
            {copied ? 'Copied' : 'Copy address'}
          </button>
        </div>
      </div>
    )
  }

  // ================= SWAP =================
  if (view === 'swap') {
    return (
      <div>
        <div className="screen-header">
          <button className="back-btn" onClick={() => setView('home')}>←</button>
          <h1>Swap</h1>
        </div>

        <div className="swap-panel">
          <div className="label">You pay</div>
          <div className="row">
            <input
              className="big-input"
              placeholder="0"
              inputMode="decimal"
              value={swapAmount}
              onChange={(e) => setSwapAmount(e.target.value)}
            />
            <span className="token">SOL</span>
          </div>
          <div className="detail-line">
            <span className="k">
              {validAmount ? `≈ ${usd(amountNum * SOL_USD)}` : '\u00a0'}
            </span>
            <button
              className="max-link"
              onClick={() => balance && setSwapAmount(String(Math.max(balance - 0.0005, 0)))}
            >
              Max {balance !== null ? balance.toFixed(4) : '...'}
            </button>
          </div>
        </div>

        <div className="swap-arrow">↓</div>

        <div className="swap-panel receive-panel">
          <div className="label">You get</div>
          <div className="row">
            <span className="big-out">
              {quote > 0 ? `≈ ${quote.toFixed(2)}` : '—'}
            </span>
            <span className="token">MAYU</span>
          </div>
          <div className="detail-line">
            <span className="k">
              {mayuUsd > 0 ? `1 MAYU ≈ ${usd(mayuUsd)}` : 'Pool is empty'}
            </span>
          </div>
        </div>

        <div style={{ margin: '12px 2px' }}>
          <div className="detail-line">
            <span className="k">Price impact</span>
            <span className="v">{validAmount ? `${priceImpact.toFixed(1)}%` : '—'}</span>
          </div>
          <div className="detail-line">
            <span className="k">Network fee</span>
            <span className="v">&lt; $0.01</span>
          </div>
        </div>

        {overBalance && (
          <div className="warn-box">That's more SOL than you have.</div>
        )}

        <button
          className="btn btn-primary"
          disabled={!validAmount || overBalance || quote <= 0}
          onClick={reviewSwap}
        >
          Review swap
        </button>
      </div>
    )
  }

  // ================= CONFIRM =================
  if (view === 'confirm' && pendingSwap) {
    return (
      <div>
        <div className="screen-header">
          <button className="back-btn" onClick={() => setView('swap')}>←</button>
          <h1>Confirm swap</h1>
        </div>

        <div className="confirm-summary">
          <div className="sub">You pay</div>
          <div className="big">{pendingSwap.solIn} SOL</div>
          <div style={{ margin: '6px 0', color: 'var(--ink-faint)' }}>↓</div>
          <div className="sub">You get at least</div>
          <div className="big get">{pendingSwap.minOut.toFixed(2)} MAYU</div>
        </div>

        <div className="divider" />

        <div className="detail-line">
          <span className="k">Rate</span>
          <span className="v">1 SOL ≈ {Math.round(pendingSwap.rate).toLocaleString()} MAYU</span>
        </div>
        <div className="detail-line">
          <span className="k">Slippage limit</span>
          <span className="v">{(SLIPPAGE * 100).toFixed(1)}%</span>
        </div>
        <div className="detail-line">
          <span className="k">Total cost</span>
          <span className="v">≈ {usd(pendingSwap.solIn * SOL_USD)}</span>
        </div>

        <div className="warn-box">
          Prices move with the market. You'll never receive less than{' '}
          {pendingSwap.minOut.toFixed(2)} MAYU or the swap cancels.
        </div>

        <button className="btn btn-primary" disabled={busy} onClick={executeSwap}>
          {busy ? 'Swapping...' : 'Confirm swap'}
        </button>
        <button className="btn-ghost" style={{ width: '100%' }} onClick={() => setView('swap')}>
          Cancel
        </button>
        <p className={`status-msg${status.error ? ' error' : ''}`}>{status.text}</p>
      </div>
    )
  }

  // ================= HOME =================
  return (
    <div>
      <div className="screen-header" style={{ justifyContent: 'space-between' }}>
        <h1>Mayu</h1>
        <button className="btn-ghost" onClick={logout}>Log out</button>
      </div>

      <div className="balance-card">
        <div className="label">Total balance</div>
        <div className="amount">
          {balance === null ? '...' : usd(totalUsd)}
        </div>
        <div className="label">Solana devnet · demo prices</div>
      </div>

      <div className="asset-row">
        <span className="sym">MAYU</span>
        <span className="amt">
          {mayuBalance === null ? '...' : `${mayuBalance.toLocaleString()} · ${usd(mayuBalance * mayuUsd)}`}
        </span>
      </div>
      <div className="asset-row">
        <span className="sym">SOL</span>
        <span className="amt">
          {balance === null ? '...' : `${balance.toFixed(4)} · ${usd(balance * SOL_USD)}`}
        </span>
      </div>

      <div className="btn-row">
        <button className="btn" onClick={() => setView('receive')}>↓ Receive</button>
        <button className="btn btn-primary" onClick={() => { setStatus({ text: '', error: false }); setView('swap') }}>
          ⇄ Swap
        </button>
      </div>

      {lastSwap && (
        <div className="txn-list">
          <div className="title">Recent</div>
          <div className="txn-row">
            <span className="what">Swapped {lastSwap.sol} SOL → MAYU</span>
            <span>+{lastSwap.mayu.toFixed(2)}</span>
          </div>
        </div>
      )}

      <details className="devtools">
        <summary>Developer tools</summary>
        <p style={{ margin: '8px 0 0' }}>
          Pool: {poolSol ?? '...'} SOL / {poolMayu ?? '...'} MAYU
        </p>
        <button className="btn" onClick={airdrop}>Request 1 devnet SOL</button>
        <button className="btn" onClick={() => setRefresh((n) => n + 1)}>Refresh balances</button>
        <button className="btn" onClick={seedPool}>Seed pool (dev)</button>
      </details>
    </div>
  )
}

export default App
