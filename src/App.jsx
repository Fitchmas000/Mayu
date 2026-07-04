import { useState, useEffect, useRef } from 'react'
import { usePrivy, useLoginWithEmail } from '@privy-io/react-auth'
import { useWallets, useCreateWallet } from '@privy-io/react-auth/solana'
import { createSolanaRpc, address } from '@solana/kit'

const rpc = createSolanaRpc('https://api.devnet.solana.com')

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

  if (!ready) return <p>Loading...</p>

  if (authenticated) {
    return (
      <div>
        <h1>Welcome to Mayu</h1>
        <p>Your Solana wallet:</p>
        <p>{solanaAccount?.address ?? 'Creating your wallet...'}</p>
        <p>Balance: {balance === null ? 'loading...' : `${balance} SOL`}</p>
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