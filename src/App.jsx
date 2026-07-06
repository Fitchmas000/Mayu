import { useState, useEffect, useRef } from 'react'
import { usePrivy, useLoginWithEmail } from '@privy-io/react-auth'
import {
  useWallets, useCreateWallet, useSignAndSendTransaction, useSignMessage,
} from '@privy-io/react-auth/solana'
import {
  createSolanaRpc, address, pipe, createNoopSigner, generateKeyPairSigner,
  createTransactionMessage, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  partiallySignTransactionMessageWithSigners, getTransactionEncoder,
  createKeyPairSignerFromPrivateKeyBytes,
} from '@solana/kit'
import { getTransferSolInstruction, getCreateAccountInstruction } from '@solana-program/system'
import {
  TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction, getTransferInstruction,
  getMintSize, getInitializeMintInstruction, getMintToInstruction
} from '@solana-program/token'

const rpc = createSolanaRpc('https://api.devnet.solana.com')
const REGISTRY_URL = 'http://localhost:3001'

// ===================================================================
// TOKEN REGISTRY
// The single source of truth for every asset the app understands.
// To add a token: add a row. Everything else (balances, swap, send)
// reads from here. Fill PLACEHOLDER mints once you create the devnet
// test tokens; tokens with a PLACEHOLDER mint are shown as unavailable.
// ===================================================================
const PLACEHOLDER = 'PLACEHOLDER'

const TOKENS = {
  SOL:  { symbol: 'SOL',  name: 'Solana',      decimals: 9, native: true,  mint: null,        usd: 82.67 },
  MAYU: { symbol: 'MAYU', name: 'Mayu',        decimals: 9, native: false, mint: 'FXpWnihk17THTFfwt4kQaX4xMhTetSwzZmSTjNhEwpAT', usd: 0.01 },
  USDC: { symbol: 'USDC', name: 'USD Coin',    decimals: 6, native: false, mint: 'Da8hHyymg9DGGvdQk8UZQ8nXhqGrj4FNfEupEtzHoJg2', usd: 1.00 },
  EURC: { symbol: 'EURC', name: 'Euro Coin',   decimals: 6, native: false, mint: '7GxpTWNnBpVedBiTuKxCru11ze4ZoFBTYnhtFzYCov8G', usd: 1.08 },
  JYPC: { symbol: 'JYPC', name: 'JPY Coin',    decimals: 0, native: false, mint: '97ZJgMVadsdY9uAaav1fZ4cMPqykjR1nx2rWGAMhKjh9', usd: 0.0067 },
  WBTC: { symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, native: false, mint: PLACEHOLDER, usd: 64000 },
  WETH: { symbol: 'WETH', name: 'Wrapped ETH', decimals: 8, native: false, mint: PLACEHOLDER, usd: 3400 },
}

// Tokens actually usable right now (real mint set).
const availableTokens = Object.values(TOKENS).filter((t) => t.native || t.mint !== PLACEHOLDER)

// ---- registry helpers ----
const isAvailable = (t) => t.native || t.mint !== PLACEHOLDER
// Human amount -> base units (BigInt), using THIS token's decimals.
const toBase = (amount, token) => BigInt(Math.round(amount * 10 ** token.decimals))
// Base units -> human amount, using this token's decimals.
const fromBase = (base, token) => Number(base) / 10 ** token.decimals

const SLIPPAGE = 0.005
const APP_FEE = 0.005 // 0.5% transparent fee — shown, never hidden
const MIN_SOL_FOR_FEE = 0.001

// constant-product quote (gross, before app fee)
function getQuote(amountIn, reserveIn, reserveOut) {
  const k = reserveIn * reserveOut
  return reserveOut - k / (reserveIn + amountIn)
}

const usd = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const fmtAmt = (n, token) => n.toFixed(Math.min(token.decimals, 6))
const shortAddr = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '')

function App() {
  const { ready, authenticated, user, logout } = usePrivy()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [loginError, setLoginError] = useState('')
  const { sendCode, loginWithCode } = useLoginWithEmail()
  const { ready: walletsReady, wallets } = useWallets()
  const { createWallet } = useCreateWallet()
  const { signAndSendTransaction } = useSignAndSendTransaction()
  const { signMessage } = useSignMessage()

  const solanaAccount = user?.linkedAccounts?.find(
    (a) => a.type === 'wallet' && a.chainType === 'solana'
  )

  const creatingRef = useRef(false)
  const [refresh, setRefresh] = useState(0)

  // balances: a map of symbol -> human amount, e.g. { SOL: 0.5, MAYU: 1000 }
  const [balances, setBalances] = useState({})
  // pool reserves: only MAYU/SOL pool exists on devnet for now
  const [pool, setPool] = useState(null)
  const [poolSol, setPoolSol] = useState(null)
  const [poolMayu, setPoolMayu] = useState(null)

  // identity
  const [username, setUsername] = useState(null)
  const [usernameChecked, setUsernameChecked] = useState(false)
  const [needsUsername, setNeedsUsername] = useState(false)
  const [claimInput, setClaimInput] = useState('')
  const [claimError, setClaimError] = useState('')
  const [claimBusy, setClaimBusy] = useState(false)

  // ui
  const [view, setView] = useState('home')
  const [menuOpen, setMenuOpen] = useState(false)
  const [status, setStatus] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  // swap state: choose which token you pay and which you receive
  const [payFrom, setPayFrom] = useState('SOL')
  const [payTo, setPayTo] = useState('MAYU')
  const [swapAmount, setSwapAmount] = useState('')
  const [pendingSwap, setPendingSwap] = useState(null)

  // send state
  const [sendName, setSendName] = useState('')
  const [sendSymbol, setSendSymbol] = useState('MAYU')
  const [sendAmount, setSendAmount] = useState('')
  const [lookupBusy, setLookupBusy] = useState(false)
  const [pendingSend, setPendingSend] = useState(null)
  const [sendError, setSendError] = useState('')

  // ----- pool signer -----
  useEffect(() => {
    const secret = import.meta.env.VITE_POOL_SECRET
    if (!secret) return
    const bytes = new Uint8Array(secret.match(/.{2}/g).map((h) => parseInt(h, 16)))
    createKeyPairSignerFromPrivateKeyBytes(bytes).then(setPool)
  }, [])

  // ----- pool reserves (MAYU/SOL) -----
  useEffect(() => {
    if (!pool) return
    const run = async () => {
      const { value: lamports } = await rpc.getBalance(pool.address).send()
      setPoolSol(Number(lamports) / 1e9)
      try {
        const [ata] = await findAssociatedTokenPda({
          mint: address(TOKENS.MAYU.mint), owner: pool.address, tokenProgram: TOKEN_PROGRAM_ADDRESS,
        })
        const { value } = await rpc.getTokenAccountBalance(ata).send()
        setPoolMayu(value.uiAmount)
      } catch { setPoolMayu(0) }
    }
    run()
  }, [pool, refresh])

  // ----- ALL balances, driven by the registry -----
  // One effect loops over every available token instead of one effect per token.
  useEffect(() => {
    if (!solanaAccount) return
    const owner = address(solanaAccount.address)
    const run = async () => {
      const next = {}
      for (const token of availableTokens) {
        try {
          if (token.native) {
            const { value } = await rpc.getBalance(owner).send()
            next[token.symbol] = Number(value) / 1e9
          } else {
            const [ata] = await findAssociatedTokenPda({
              mint: address(token.mint), owner, tokenProgram: TOKEN_PROGRAM_ADDRESS,
            })
            const { value } = await rpc.getTokenAccountBalance(ata).send()
            next[token.symbol] = value.uiAmount ?? 0
          }
        } catch {
          next[token.symbol] = 0 // no account yet = zero balance
        }
      }
      setBalances(next)
    }
    run()
  }, [solanaAccount, refresh])

  // ----- auto-create wallet -----
  useEffect(() => {
    if (!authenticated || !walletsReady || solanaAccount || creatingRef.current) return
    creatingRef.current = true
    createWallet()
      .then(({ wallet }) => console.log('auto-created:', wallet))
      .catch((err) => console.error('auto-create failed:', err))
  }, [authenticated, walletsReady, solanaAccount])

  // ----- username check -----
  useEffect(() => {
    if (!solanaAccount) return
    const run = async () => {
      try {
        const res = await fetch(`${REGISTRY_URL}/whois/${solanaAccount.address}`)
        if (res.ok) { const d = await res.json(); setUsername(d.name); setNeedsUsername(false) }
        else if (res.status === 404) { setUsername(null); setNeedsUsername(true) }
      } catch { setNeedsUsername(false) }
      finally { setUsernameChecked(true) }
    }
    run()
  }, [solanaAccount, refresh])

  // ----- derived: total balance in USD across all held tokens -----
  const totalUsd = availableTokens.reduce(
    (sum, t) => sum + (balances[t.symbol] ?? 0) * t.usd, 0
  )
  const solBalance = balances.SOL ?? null
  const lowSol = solBalance !== null && solBalance < MIN_SOL_FOR_FEE

  // ----- swap quote (currently only the SOL<->MAYU pool has liquidity) -----
  const fromToken = TOKENS[payFrom]
  const toToken = TOKENS[payTo]
  const amountNum = Number(swapAmount)
  const validAmount = swapAmount !== '' && !Number.isNaN(amountNum) && amountNum > 0

  // Which pool reserves apply? Only SOL/MAYU exists on devnet.
  const pairIsSolMayu =
    (payFrom === 'SOL' && payTo === 'MAYU') || (payFrom === 'MAYU' && payTo === 'SOL')
  const reserveIn = payFrom === 'SOL' ? poolSol : poolMayu
  const reserveOut = payFrom === 'SOL' ? poolMayu : poolSol

  const grossOut =
    validAmount && pairIsSolMayu && reserveIn > 0 && reserveOut > 0
      ? getQuote(amountNum, reserveIn, reserveOut) : 0
  const feeAmount = grossOut * APP_FEE          // our transparent fee, taken from output
  const netOut = grossOut - feeAmount           // what the user actually receives
  const payBalance = balances[payFrom] ?? null
  const overBalance = validAmount && payBalance !== null && amountNum > payBalance

  // ----- ceremony -----
  const sendInstructions = async (instructions, ownerSigner) => {
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
      transaction: new Uint8Array(txBytes), wallet: wallets[0], chain: 'solana:devnet',
    })
  }

  // ----- claim username -----
  const claimUsername = async () => {
    const name = claimInput.trim().toLowerCase().replace(/^@/, '')
    setClaimError('')
    if (!/^[a-z0-9_]{3,20}$/.test(name)) {
      setClaimError('3-20 characters: letters, numbers, or underscore.'); return
    }
    setClaimBusy(true)
    try {
      const messageText = `mayu-registry claim: ${name} -> ${solanaAccount.address}`
      const { signature } = await signMessage({
        message: new TextEncoder().encode(messageText), wallet: wallets[0],
      })
      const res = await fetch(`${REGISTRY_URL}/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, address: solanaAccount.address,
          signature: btoa(String.fromCharCode(...signature)),
        }),
      })
      const data = await res.json()
      if (!res.ok) { setClaimError(data.error || 'Could not claim that name.'); return }
      setUsername(name); setNeedsUsername(false); setClaimInput(''); setView('home')
    } catch (err) {
      console.error('claim failed:', err); setClaimError('Something went wrong claiming that name.')
    } finally { setClaimBusy(false) }
  }

  // ----- swap review / execute -----
  const flipSwap = () => { setPayFrom(payTo); setPayTo(payFrom); setSwapAmount('') }

  const reviewSwap = () => {
    if (!validAmount || overBalance || netOut <= 0 || lowSol) return
    setPendingSwap({
      fromSymbol: payFrom, toSymbol: payTo,
      amountIn: amountNum, grossOut, feeAmount, netOut,
      minOut: netOut * (1 - SLIPPAGE),
    })
    setStatus({ text: '', error: false })
    setView('confirm')
  }

  const executeSwap = async () => {
    if (!pendingSwap || !pool) return
    setBusy(true); setStatus({ text: 'Swapping...', error: false })
    try {
      const owner = address(solanaAccount.address)
      const ownerSigner = createNoopSigner(owner)
      const inTok = TOKENS[pendingSwap.fromSymbol]
      const outTok = TOKENS[pendingSwap.toSymbol]
      const inBase = toBase(pendingSwap.amountIn, inTok)
      const outBase = toBase(pendingSwap.netOut, outTok)

      const [userMayuAta] = await findAssociatedTokenPda({
        mint: address(TOKENS.MAYU.mint), owner, tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
      const [poolMayuAta] = await findAssociatedTokenPda({
        mint: address(TOKENS.MAYU.mint), owner: pool.address, tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })

      // buy = pay SOL, get MAYU ; sell = pay MAYU, get SOL
      const buying = pendingSwap.fromSymbol === 'SOL'
      const instructions = buying
        ? [
            getTransferSolInstruction({ source: ownerSigner, destination: pool.address, amount: inBase }),
            getTransferInstruction({ source: poolMayuAta, destination: userMayuAta, authority: pool, amount: outBase }),
          ]
        : [
            getTransferInstruction({ source: userMayuAta, destination: poolMayuAta, authority: ownerSigner, amount: inBase }),
            getTransferSolInstruction({ source: pool, destination: owner, amount: outBase }),
          ]

      await sendInstructions(instructions, ownerSigner)
      setSwapAmount(''); setPendingSwap(null); setStatus({ text: '', error: false }); setView('home')
      setTimeout(() => setRefresh((n) => n + 1), 2000)
    } catch (err) {
      console.error('swap failed:', err)
      setStatus({ text: "The swap didn't go through. Nothing was moved.", error: true })
    } finally { setBusy(false) }
  }

  // ----- send -----
  const resolveName = async (name) => {
    try {
      const res = await fetch(`${REGISTRY_URL}/resolve/${name}`)
      if (!res.ok) return null
      return (await res.json()).address
    } catch { return null }
  }

  const reviewSend = async () => {
    setSendError('')
    const name = sendName.trim().toLowerCase().replace(/^@/, '')
    const amount = Number(sendAmount)
    const token = TOKENS[sendSymbol]
    if (!name) { setSendError('Enter a name to send to.'); return }
    if (Number.isNaN(amount) || amount <= 0) { setSendError('Enter an amount greater than zero.'); return }
    const bal = balances[sendSymbol] ?? 0
    if (amount > bal) { setSendError(`That's more ${sendSymbol} than you have.`); return }
    if (lowSol) { setSendError('You need a little SOL to cover the network fee.'); return }

    setLookupBusy(true)
    const resolved = await resolveName(name)
    setLookupBusy(false)
    if (!resolved) { setSendError(`@${name} isn't registered.`); return }
    if (resolved === solanaAccount.address) { setSendError("That's your own address."); return }

    setPendingSend({ name, address: resolved, symbol: sendSymbol, amount })
    setView('sendConfirm')
  }

  const executeSend = async () => {
    if (!pendingSend) return
    setBusy(true); setStatus({ text: 'Sending...', error: false })
    try {
      const owner = address(solanaAccount.address)
      const ownerSigner = createNoopSigner(owner)
      const recipient = address(pendingSend.address)
      const token = TOKENS[pendingSend.symbol]
      const baseAmount = toBase(pendingSend.amount, token)

      let instructions
      if (token.native) {
        instructions = [
          getTransferSolInstruction({ source: ownerSigner, destination: recipient, amount: baseAmount }),
        ]
      } else {
        const [fromAta] = await findAssociatedTokenPda({
          mint: address(token.mint), owner, tokenProgram: TOKEN_PROGRAM_ADDRESS,
        })
        const [toAta] = await findAssociatedTokenPda({
          mint: address(token.mint), owner: recipient, tokenProgram: TOKEN_PROGRAM_ADDRESS,
        })
        instructions = [
          getCreateAssociatedTokenIdempotentInstruction({
            payer: ownerSigner, ata: toAta, owner: recipient, mint: address(token.mint),
          }),
          getTransferInstruction({ source: fromAta, destination: toAta, authority: ownerSigner, amount: baseAmount }),
        ]
      }
      await sendInstructions(instructions, ownerSigner)
      setStatus({ text: '', error: false }); setSendName(''); setSendAmount(''); setPendingSend(null); setView('home')
      setTimeout(() => setRefresh((n) => n + 1), 2000)
    } catch (err) {
      console.error('send failed:', err)
      setStatus({ text: "The transfer didn't go through. Nothing was moved.", error: true })
    } finally { setBusy(false) }
  }

  // ----- dev -----
  const airdrop = async () => {
    try {
      await rpc.requestAirdrop(address(solanaAccount.address), 1_000_000_000n).send()
      setTimeout(() => setRefresh((n) => n + 1), 2000)
    } catch (err) { console.error('airdrop failed:', err) }
  }
  const seedPool = async () => {
    try {
      const owner = address(solanaAccount.address)
      const ownerSigner = createNoopSigner(owner)
      const [userAta] = await findAssociatedTokenPda({ mint: address(TOKENS.MAYU.mint), owner, tokenProgram: TOKEN_PROGRAM_ADDRESS })
      const [poolAta] = await findAssociatedTokenPda({ mint: address(TOKENS.MAYU.mint), owner: pool.address, tokenProgram: TOKEN_PROGRAM_ADDRESS })
      await sendInstructions([
        getTransferSolInstruction({ source: ownerSigner, destination: pool.address, amount: 2_000_000n }),
        getCreateAssociatedTokenIdempotentInstruction({ payer: ownerSigner, ata: poolAta, owner: pool.address, mint: address(TOKENS.MAYU.mint) }),
        getTransferInstruction({ source: userAta, destination: poolAta, authority: ownerSigner, amount: 16_534_000_000n }),
      ], ownerSigner)
      setTimeout(() => setRefresh((n) => n + 1), 2000)
    } catch (err) { console.error('seed failed:', err) }
  }

  const mintTestToken = async (symbol, decimals, supply) => {
    try {
      const owner = address(solanaAccount.address)
      const ownerSigner = createNoopSigner(owner)
      const mint = await generateKeyPairSigner()
      const space = BigInt(getMintSize())
      const rent = await rpc.getMinimumBalanceForRentExemption(space).send()
      const [ata] = await findAssociatedTokenPda({
        mint: mint.address, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
      const amount = BigInt(supply) * 10n ** BigInt(decimals)
      await sendInstructions([
        getCreateAccountInstruction({
          payer: ownerSigner, newAccount: mint, lamports: rent, space,
          programAddress: TOKEN_PROGRAM_ADDRESS,
        }),
        getInitializeMintInstruction({
          mint: mint.address, decimals, mintAuthority: owner,
        }),
        getCreateAssociatedTokenIdempotentInstruction({
          payer: ownerSigner, ata, owner, mint: mint.address,
        }),
        getMintToInstruction({
          mint: mint.address, token: ata, mintAuthority: ownerSigner, amount,
        }),
      ], ownerSigner)
      console.log(`${symbol}: mint '${mint.address}',`)
    } catch (err) {
      console.error(`${symbol} mint failed:`, err)
    }
  }

  const copyAddress = async () => {
    await navigator.clipboard.writeText(solanaAccount.address)
    setCopied(true); setTimeout(() => setCopied(false), 1500)
  }
  const doLogout = () => {
    setMenuOpen(false); setUsername(null); setUsernameChecked(false)
    setNeedsUsername(false); setView('home'); logout()
  }

  if (!ready) return <p className="muted" style={{ textAlign: 'center', paddingTop: '30vh' }}>Loading...</p>

  // ================= LOGIN =================
  if (!authenticated) {
    return (
      <div className="login-wrap">
        <div className="logo">M</div>
        <h1>Mayu</h1>
        <p className="tagline">Honest currency exchange, in your pocket.</p>
        <input className="field" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        {!codeSent ? (
          <button className="btn btn-swap" onClick={async () => {
            setLoginError('')
            try { await sendCode({ email }); setCodeSent(true) }
            catch (err) { console.error(err); setLoginError("That doesn't look like a valid email address.") }
          }}>Send code</button>
        ) : (
          <>
            <input className="field" placeholder="6-digit code from your email" value={code} onChange={(e) => setCode(e.target.value)} />
            <button className="btn btn-swap" onClick={() => loginWithCode({ code })}>Log in</button>
            <button className="btn-ghost" onClick={() => { setCodeSent(false); setLoginError('') }}>Use a different email</button>
          </>
        )}
        {loginError && <p className="status-msg error">{loginError}</p>}
      </div>
    )
  }

  // ================= ONBOARDING =================
  if (usernameChecked && needsUsername && !username) {
    return (
      <div className="login-wrap">
        <div className="logo">M</div>
        <h1>Pick your username</h1>
        <p className="tagline">This is how friends send you money — like @mason.</p>
        <input className="field" placeholder="username" value={claimInput} onChange={(e) => setClaimInput(e.target.value)} />
        <button className="btn btn-swap" disabled={claimBusy} onClick={claimUsername}>
          {claimBusy ? 'Claiming...' : 'Claim username'}
        </button>
        {claimError && <p className="status-msg error">{claimError}</p>}
        <button className="btn-ghost" onClick={doLogout}>Log out</button>
      </div>
    )
  }

  // ================= RECEIVE =================
  if (view === 'receive') {
    return (
      <div>
        <div className="screen-header"><button className="back-btn" onClick={() => setView('home')}>←</button><h1>Receive</h1></div>
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            {username ? `Friends can send to @${username}. ` : ''}Or share your address:
          </p>
          <p className="mono">{solanaAccount?.address}</p>
          <button className="btn" onClick={copyAddress}>{copied ? 'Copied' : 'Copy address'}</button>
        </div>
      </div>
    )
  }

  // ================= ACCOUNT =================
  if (view === 'account') {
    return (
      <div>
        <div className="screen-header"><button className="back-btn" onClick={() => setView('home')}>←</button><h1>Account</h1></div>
        <div className="card">
          <div className="detail-line"><span className="k">Username</span><span className="v">{username ? `@${username}` : 'none yet'}</span></div>
          <div style={{ marginTop: 14 }}>
            <div className="muted" style={{ marginBottom: 4 }}>Wallet address</div>
            <p className="mono" style={{ margin: 0 }}>{solanaAccount?.address}</p>
          </div>
          <button className="btn" style={{ marginTop: 14 }} onClick={copyAddress}>{copied ? 'Copied' : 'Copy address'}</button>
        </div>
      </div>
    )
  }

  // ================= SEND =================
  if (view === 'send') {
    return (
      <div>
        <div className="screen-header"><button className="back-btn" onClick={() => setView('home')}>←</button><h1>Send</h1></div>
        <div className="swap-panel">
          <div className="label">To</div>
          <div className="row">
            <span className="token" style={{ color: 'var(--ink-faint)' }}>@</span>
            <input className="big-input" placeholder="name" value={sendName} onChange={(e) => setSendName(e.target.value)} style={{ textAlign: 'left' }} />
          </div>
        </div>
        <div style={{ height: 12 }} />
        <div className="swap-panel">
          <div className="label">Amount</div>
          <div className="row">
            <input className="big-input" placeholder="0" inputMode="decimal" value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} />
            <select className="token-select" value={sendSymbol} onChange={(e) => setSendSymbol(e.target.value)}>
              {availableTokens.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
            </select>
          </div>
          <div className="detail-line">
            <span className="k">Balance: {(balances[sendSymbol] ?? 0).toLocaleString()} {sendSymbol}</span>
          </div>
        </div>
        {sendError && <div className="warn-box" style={{ marginTop: 14 }}>{sendError}</div>}
        <button className="btn btn-buy" disabled={lookupBusy} onClick={reviewSend} style={{ marginTop: 14 }}>
          {lookupBusy ? 'Looking up...' : 'Review'}
        </button>
      </div>
    )
  }

  // ================= SEND CONFIRM =================
  if (view === 'sendConfirm' && pendingSend) {
    const token = TOKENS[pendingSend.symbol]
    return (
      <div>
        <div className="screen-header"><button className="back-btn" onClick={() => setView('send')}>←</button><h1>Confirm send</h1></div>
        <div className="confirm-summary">
          <div className="sub">Sending</div>
          <div className="big">{fmtAmt(pendingSend.amount, token)} {pendingSend.symbol}</div>
          <div style={{ margin: '6px 0', color: 'var(--ink-faint)' }}>↓</div>
          <div className="sub">To</div>
          <div className="big get">@{pendingSend.name}</div>
          <div className="mono" style={{ marginTop: 6, fontSize: 13 }}>{shortAddr(pendingSend.address)}</div>
        </div>
        <div className="warn-box">Double-check the address matches who you mean to pay. Transfers can't be reversed.</div>
        <button className="btn btn-buy" disabled={busy} onClick={executeSend}>{busy ? 'Sending...' : `Send ${pendingSend.symbol}`}</button>
        <button className="btn-ghost" style={{ width: '100%' }} onClick={() => setView('send')}>Cancel</button>
        <p className={`status-msg${status.error ? ' error' : ''}`}>{status.text}</p>
      </div>
    )
  }

  // ================= SWAP =================
  if (view === 'swap') {
    const canSwapPair = pairIsSolMayu // only pair with liquidity on devnet
    return (
      <div>
        <div className="screen-header"><button className="back-btn" onClick={() => setView('home')}>←</button><h1>Swap</h1></div>

        <div className="swap-panel">
          <div className="label">You pay</div>
          <div className="row">
            <input className="big-input" placeholder="0" inputMode="decimal" value={swapAmount} onChange={(e) => setSwapAmount(e.target.value)} />
            <select className="token-select" value={payFrom} onChange={(e) => setPayFrom(e.target.value)}>
              {availableTokens.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
            </select>
          </div>
          <div className="detail-line">
            <span className="k">{validAmount ? `≈ ${usd(amountNum * fromToken.usd)}` : '\u00a0'}</span>
            <button className="max-link" onClick={() => payBalance && setSwapAmount(String(payFrom === 'SOL' ? Math.max(payBalance - 0.0005, 0) : payBalance))}>
              Max {payBalance !== null ? payBalance.toLocaleString() : '...'}
            </button>
          </div>
        </div>

        <button onClick={flipSwap} title="Switch" style={{
          display: 'block', margin: '6px auto', width: 34, height: 34, borderRadius: '50%',
          border: '1px solid var(--line-strong)', background: 'var(--surface-3)',
          color: 'var(--swap)', fontSize: 16, cursor: 'pointer', lineHeight: 1,
        }}>⇅</button>

        <div className="swap-panel receive-panel">
          <div className="label">You get</div>
          <div className="row">
            <span className="big-out">{netOut > 0 ? `≈ ${fmtAmt(netOut, toToken)}` : '—'}</span>
            <select className="token-select" value={payTo} onChange={(e) => setPayTo(e.target.value)}>
              {availableTokens.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
            </select>
          </div>
          <div className="detail-line"><span className="k">{netOut > 0 ? `≈ ${usd(netOut * toToken.usd)}` : ''}</span></div>
        </div>

        {/* HONEST FEE BREAKDOWN — the heart of the product */}
        {validAmount && canSwapPair && grossOut > 0 && (
          <div className="fee-box">
            <div className="fee-title">Fee breakdown</div>
            <div className="detail-line"><span className="k">Market rate gives</span><span className="v">{fmtAmt(grossOut, toToken)} {payTo}</span></div>
            <div className="detail-line"><span className="k">Our fee (0.5%)</span><span className="v">−{fmtAmt(feeAmount, toToken)} {payTo}</span></div>
            <div className="detail-line"><span className="k">Network fee</span><span className="v">&lt; $0.01</span></div>
            <div className="detail-line" style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <span className="k" style={{ color: 'var(--ink)' }}>You receive</span>
              <span className="v" style={{ color: 'var(--buy)' }}>{fmtAmt(netOut, toToken)} {payTo}</span>
            </div>
          </div>
        )}

        {payFrom === payTo && <div className="warn-box">Pick two different tokens.</div>}
        {payFrom !== payTo && !canSwapPair && <div className="warn-box">No pool for {payFrom}/{payTo} on devnet yet. Only SOL/MAYU has liquidity.</div>}
        {overBalance && <div className="warn-box">That's more {payFrom} than you have.</div>}
        {lowSol && !overBalance && <div className="warn-box">You need a little SOL to cover the network fee.</div>}

        <button className="btn btn-swap" disabled={!validAmount || overBalance || netOut <= 0 || lowSol || !canSwapPair} onClick={reviewSwap}>
          Review swap
        </button>
      </div>
    )
  }

  // ================= SWAP CONFIRM =================
  if (view === 'confirm' && pendingSwap) {
    const outTok = TOKENS[pendingSwap.toSymbol]
    return (
      <div>
        <div className="screen-header"><button className="back-btn" onClick={() => setView('swap')}>←</button><h1>Confirm swap</h1></div>
        <div className="confirm-summary">
          <div className="sub">You pay</div>
          <div className="big">{pendingSwap.amountIn} {pendingSwap.fromSymbol}</div>
          <div style={{ margin: '6px 0', color: 'var(--ink-faint)' }}>↓</div>
          <div className="sub">You get at least</div>
          <div className="big get">{fmtAmt(pendingSwap.minOut, outTok)} {pendingSwap.toSymbol}</div>
        </div>
        <div className="fee-box">
          <div className="detail-line"><span className="k">Market rate gives</span><span className="v">{fmtAmt(pendingSwap.grossOut, outTok)} {pendingSwap.toSymbol}</span></div>
          <div className="detail-line"><span className="k">Our fee (0.5%)</span><span className="v">−{fmtAmt(pendingSwap.feeAmount, outTok)} {pendingSwap.toSymbol}</span></div>
          <div className="detail-line"><span className="k">Slippage limit</span><span className="v">{(SLIPPAGE * 100).toFixed(1)}%</span></div>
        </div>
        <div className="warn-box">Prices move with the market. You'll never receive less than {fmtAmt(pendingSwap.minOut, outTok)} {pendingSwap.toSymbol} or the swap cancels.</div>
        <button className="btn btn-swap" disabled={busy} onClick={executeSwap}>{busy ? 'Swapping...' : 'Confirm swap'}</button>
        <button className="btn-ghost" style={{ width: '100%' }} onClick={() => setView('swap')}>Cancel</button>
        <p className={`status-msg${status.error ? ' error' : ''}`}>{status.text}</p>
      </div>
    )
  }

  // ================= HOME =================
  return (
    <div>
      <div className="screen-header" style={{ justifyContent: 'space-between', position: 'relative' }}>
        <h1>Mayu</h1>
        <div style={{ position: 'relative' }}>
          <button className="btn-ghost" onClick={() => setMenuOpen((o) => !o)}>{username ? `@${username}` : 'Account'} ▾</button>
          {menuOpen && (
            <div className="menu-dropdown">
              <button onClick={() => { setMenuOpen(false); setView('account') }}>Account</button>
              <button className="signout" onClick={doLogout}>Sign out</button>
            </div>
          )}
        </div>
      </div>

      <div className="balance-card">
        <div className="label">Total balance</div>
        <div className="amount">{Object.keys(balances).length === 0 ? '...' : usd(totalUsd)}</div>
        <div className="label">Solana devnet · demo prices</div>
      </div>

      {availableTokens.map((t) => (
        <div className="asset-row" key={t.symbol}>
          <span><span className="sym">{t.symbol}</span><span className="name">{t.name}</span></span>
          <span className="amt">
            {balances[t.symbol] === undefined ? '...' : `${balances[t.symbol].toLocaleString()} · ${usd((balances[t.symbol] ?? 0) * t.usd)}`}
          </span>
        </div>
      ))}

      <div className="btn-row">
        <button className="btn btn-buy" onClick={() => setView('receive')}>↓ Receive</button>
        <button className="btn btn-sell" onClick={() => { setSendError(''); setView('send') }}>↑ Send</button>
        <button className="btn btn-swap" onClick={() => { setStatus({ text: '', error: false }); setView('swap') }}>⇄ Swap</button>
      </div>

      <details className="devtools">
        <summary>Developer tools</summary>
        <p style={{ margin: '8px 0 0' }}>Pool: {poolSol ?? '...'} SOL / {poolMayu ?? '...'} MAYU</p>
        <button className="btn" onClick={airdrop}>Request 1 devnet SOL</button>
        <button className="btn" onClick={() => setRefresh((n) => n + 1)}>Refresh balances</button>
        <button className="btn" onClick={seedPool}>Seed pool (dev)</button>
        <button className="btn" onClick={() => mintTestToken('USDC', 6, 100000)}>Mint test USDC</button>
        <button className="btn" onClick={() => mintTestToken('EURC', 6, 100000)}>Mint test EURC</button>
        <button className="btn" onClick={() => mintTestToken('JYPC', 0, 10000000)}>Mint test JYPC</button>
      </details>
    </div>
  )
}

export default App
