import { useState, useEffect, useRef } from 'react'
import { usePrivy, useLoginWithEmail } from '@privy-io/react-auth'
import { useWallets, useCreateWallet, useSignAndSendTransaction } from '@privy-io/react-auth/solana'
import {
  createSolanaRpc, address, pipe, generateKeyPairSigner, createNoopSigner,
  createTransactionMessage, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  partiallySignTransactionMessageWithSigners, getTransactionEncoder, getBase58Decoder,
} from '@solana/kit'
import { getCreateAccountInstruction } from '@solana-program/system'
import {
  TOKEN_PROGRAM_ADDRESS, getMintSize, getInitializeMintInstruction,
  findAssociatedTokenPda, getCreateAssociatedTokenInstruction, getMintToInstruction,
} from '@solana-program/token'

const rpc = createSolanaRpc('https://api.devnet.solana.com')
const MAYU_MINT = address('FXpWnihk17THTFfwt4kQaX4xMhTetSwzZmSTjNhEwpAT')

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

  if (!ready) return <p>Loading...</p>

  if (authenticated) {
    return (
      <div>
        <h1>Welcome to Mayu</h1>
        <p>Your Solana wallet:</p>
        <p>{solanaAccount?.address ?? 'Creating your wallet...'}</p>
        <p>Balance: {balance === null ? 'loading...' : `${balance} SOL`}</p>
        <p>Balance: {mayuBalance === null ? 'loading...' : `${mayuBalance} MAYU`}</p>
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
        <button onClick={mintMayu}>Mint Mayu</button>
        {mintAddress && <p>Mayu mint: {mintAddress}</p>}
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