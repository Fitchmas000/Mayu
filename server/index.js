const nacl = require('tweetnacl')
const bs58 = require('bs58').default

const express = require('express')
const cors = require('cors')
const fs = require('fs')

const app = express()
app.use(cors())
app.use(express.json())

const DB_FILE = './names.json'
const loadNames = () =>
  fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {}
const saveNames = (names) =>
  fs.writeFileSync(DB_FILE, JSON.stringify(names, null, 2))

const NAME_RULES = /^[a-z0-9_]{3,20}$/
const RESERVED = ['mason', 'masonfitch', 'simplynum', 'simplynumnum', 'admin', 'support', 'help']

app.get('/health', (req, res) => {
  res.json({ ok: true })
})

app.post('/claim', (req, res) => {
  const { name, address, signature } = req.body

  if (typeof name !== 'string' || !NAME_RULES.test(name)) {
    return res.status(400).json({ error: 'Names are 3-20 chars: a-z, 0-9, _' })
  }
  if (RESERVED.includes(name)) {
    return res.status(403).json({ error: 'That name is reserved' })
  }
  if (typeof address !== 'string' || address.length < 32) {
    return res.status(400).json({ error: 'Invalid address' })
  }
  if (typeof signature !== 'string') {
    return res.status(400).json({ error: 'Missing signature' })
  }

  const messageText = `mayu-registry claim: ${name} -> ${address}`
  let verified = false
  console.log('SERVER checks:', JSON.stringify(messageText))
  console.log('sig bytes:', Buffer.from(signature, 'base64').length, 'pubkey bytes:', bs58.decode(address).length)
  try {
    verified = nacl.sign.detached.verify(
      new TextEncoder().encode(messageText),
      Buffer.from(signature, 'base64'),
      bs58.decode(address),
    )
  } catch {
    verified = false
  }
  if (!verified) {
    return res.status(401).json({ error: 'Signature does not prove ownership of this address' })
  }

  const names = loadNames()
  if (names[name]) {
    return res.status(409).json({ error: 'Name already taken' })
  }
  if (Object.values(names).includes(address)) {
    return res.status(409).json({ error: 'This wallet already has a name' })
  }

  names[name] = address
  saveNames(names)
  res.json({ name, address })
})

app.get('/resolve/:name', (req, res) => {
  const names = loadNames()
  const address = names[req.params.name]
  if (!address) return res.status(404).json({ error: 'Name not found' })
  res.json({ name: req.params.name, address })
})

app.listen(3001, () => console.log('Mayu registry listening on http://localhost:3001'))