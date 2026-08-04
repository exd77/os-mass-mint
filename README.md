# OS Mass Mint — NFT Minting Panel

Web panel + CLI tools for minting NFTs on OpenSea (SeaDrop) and any EVM chain.

## Features

- **Web Panel** — Full dashboard with 7 tabs (Mint, Mass Mint, Wallets, Chains, Config, Jobs, Logs)
- **Single Mint** — Paste OpenSea URL, resolve, dry-run, execute
- **Mass Mint** — Multi-wallet parallel minting with configurable concurrency
- **SeaDrop Detection** — Auto-detect SeaDrop contracts, auto-discover addresses
- **20+ Chains** — Ethereum, Base, Polygon, Arbitrum, Optimism, BSC, Zora, Robinhood, and any custom chain
- **Custom RPC** — Add private RPC (Alchemy/Infura/QuickNode) from the web panel
- **Wallet Management** — Generate, delete, check balances from the web panel
- **Password Protection** — scrypt-hashed auth, session-based
- **Real-time Logs** — Socket.IO live streaming with filter and download
- **Job Tracking** — History, status, per-job logs
- **Zero Browser** — 100% API + RPC, no browser automation needed

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/exd77/os-mass-mint.git
cd os-mass-mint
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env — set your PRIVATE_KEY, RPC endpoints, and OpenSea API key
nano .env
```

Get your OpenSea API key here: https://docs.opensea.io/reference/api-keys

### 3. Setup Wallets

Create `wallets/evm-wallets.json`:

```json
[
  {
    "index": 1,
    "address": "0xYourAddress1",
    "privateKey": "0xYourPrivateKey1",
    "mnemonic": "your twelve word mnemonic phrase here for wallet one"
  },
  {
    "index": 2,
    "address": "0xYourAddress2",
    "privateKey": "0xYourPrivateKey2",
    "mnemonic": "your twelve word mnemonic phrase here for wallet two"
  }
]
```

Or generate wallets from the CLI:

```bash
node -e "
const { Wallet } = require('ethers');
const fs = require('fs');
const wallets = [];
for (let i = 0; i < 5; i++) {
  const w = Wallet.createRandom();
  wallets.push({ index: i+1, address: w.address, privateKey: w.privateKey, mnemonic: w.mnemonic.phrase });
}
fs.writeFileSync('wallets/evm-wallets.json', JSON.stringify(wallets, null, 2));
console.log('Generated 5 wallets');
"
```

### 4. Start the Web Panel

```bash
node src/server.js
```

Open: **http://localhost:3137**

First visit prompts you to set a password. After that you login and the panel is ready.

### 5. Mint

**From the web panel (recommended):**

- Go to the **Mint** tab
- Paste an OpenSea collection URL like `https://opensea.io/collection/your-collection`
- Select chain, wallet, and quantity
- Click **Dry Run** to verify, then **Mint** to execute

**From the CLI:**

```bash
# Single mint
node src/mint.js "https://opensea.io/collection/hoodies-879658705" robinhood 1 --dry-run
node src/mint.js "https://opensea.io/collection/hoodies-879658705" robinhood 1

# Mass mint across multiple wallets
node src/mass-mint.js "https://opensea.io/collection/hoodies-879658705" robinhood 1 --wallets wallets/evm-wallets.json --max-concurrent 5
```

## Workflow

```
Paste URL ──────> Resolve ──────> Dry Run
OpenSea          Contract+       Simulate
or 0xAddress     Chain+Price     No gas cost
                                      │
                  View Logs <──── Execute
                  Track Job       Mint NFTs
```

### Mint Tab Workflow

1. **Input** — Paste OpenSea URL or contract address
2. **Chain** — Select from dropdown (8 native + custom chains)
3. **Wallet** — Select from your wallets
4. **Quantity** — How many NFTs to mint per transaction
5. **Resolve** — Auto-fetch contract address, chain, collection name from OpenSea API
6. **Dry Run** — Simulate the transaction without gas, detect mint function, check price
7. **Mint** — Execute the real transaction, wait for confirmation, see token IDs

### Mass Mint Tab Workflow

1. **Input** — Same as Mint tab
2. **Wallets** — Checkbox selection (select all / select none)
3. **Amount per wallet** — Quantity per wallet
4. **Concurrency** — Max parallel wallets (default 5)
5. **Execute** — Run all wallets in parallel, track per-wallet results

### SeaDrop Detection Flow

```
Input: OpenSea URL or Contract Address
    │
    v
Resolve via OpenSea API
    │
    v
Check mint function on contract
    │
    ├── publicMint() -----> direct mint
    ├── mint() ------------> direct mint
    ├── safeMint() --------> direct mint
    ├── mintSeaDrop() -----> SeaDrop detected
    │       │
    │       v
    │   Discover SeaDrop address
    │   ├── Known chain ----> use known address
    │   └── Unknown chain --> scan on-chain tx history
    │       │
    │       v
    │   Read price from SeaDrop contract
    │       │
    │       v
    │   Call mintPublic(nftContract, feeRecipient, minter, quantity)
    │
    └── No mint function --> error
```

## Supported Chains

| Chain | Chain ID | Status |
|-------|----------|--------|
| Ethereum | 1 | Native |
| Base | 8453 | Native |
| Polygon | 137 | Native |
| Arbitrum | 42161 | Native |
| Optimism | 10 | Native |
| BSC | 56 | Native |
| Zora Network | 7777777 | Native |
| Robinhood | 4663 | Native |
| Custom | Any | Add via Chains tab |

Add custom chains from the **Chains** tab — any EVM chain with any RPC (public or private Alchemy/Infura/QuickNode).

## Web Panel Tabs

| Tab | Function |
|-----|----------|
| **Mint** | Single NFT minting with resolve and dry-run |
| **Mass Mint** | Multi-wallet parallel minting |
| **Wallets** | List, generate, delete, check balances |
| **Chains** | Add/edit/delete custom RPC chains, test connectivity |
| **Config** | Edit .env, change password, security settings |
| **Jobs** | Job history with status badges and per-job logs |
| **Logs** | Real-time monitoring, filter, download |

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/chains` | GET | Session | List all chains |
| `/api/chains` | POST | Session | Add custom chain |
| `/api/chains/:name` | PUT | Session | Update chain |
| `/api/chains/:name` | DELETE | Session | Delete chain |
| `/api/chains/test` | POST | Session | Test RPC connectivity |
| `/api/wallets` | GET | Session | List wallets |
| `/api/wallets/generate` | POST | Session | Generate N wallets |
| `/api/wallets/:identifier` | DELETE | Session | Delete wallet (by address or index) |
| `/api/wallet/:addr` | GET | Session | Wallet balance across chains |
| `/api/resolve` | POST | Session | Resolve OpenSea URL to contract |
| `/api/mint` | POST | Session | Execute mint (dryRun: true/false) |
| `/api/mass-mint` | POST | Session | Execute mass mint |
| `/api/jobs` | GET | Session | List jobs |
| `/api/jobs/:id` | GET | Session | Job detail with logs |
| `/api/config` | GET | Session | Load config |
| `/api/config` | POST | Session | Save config |
| `/api/auth/status` | GET | Public | Auth status |
| `/api/auth/login` | POST | Public | Login |
| `/api/auth/logout` | POST | Session | Logout |
| `/api/auth/setup` | POST | Public | First-time password setup |
| `/api/auth/change-password` | POST | Session | Change password |

## CLI Usage

### mint.js — Single Mint

```bash
node src/mint.js <url-or-contract> <chain> <amount> [--dry-run] [--wallet <privateKey>]
```

```bash
# Dry run (no gas)
node src/mint.js "https://opensea.io/collection/hoodies-879658705" robinhood 1 --dry-run

# Real mint
node src/mint.js "https://opensea.io/collection/hoodies-879658705" robinhood 1

# Use specific wallet
node src/mint.js "https://opensea.io/collection/hoodies-879658705" robinhood 1 --wallet 0xABC...

# Direct contract address
node src/mint.js 0x00f1cc315e2f3534d9a896cf0ef174866e1419e3 robinhood 1
```

### mass-mint.js — Multi-Wallet Mint

```bash
node src/mass-mint.js <url> <chain> <amount-per-wallet> [--wallets <file>] [--max-concurrent <n>]
```

```bash
# Mass mint 1 NFT per wallet, 5 concurrent
node src/mass-mint.js "https://opensea.io/collection/hoodies-879658705" robinhood 1 --max-concurrent 5

# Custom wallets file
node src/mass-mint.js "https://opensea.io/collection/hoodies-879658705" robinhood 1 --wallets wallets/my-wallets.json
```

## Project Structure

```
os-mass-mint/
├── package.json          # Dependencies and scripts
├── .env.example          # Config template (no secrets)
├── .gitignore            # Excludes .env, .auth.json, wallets/
├── chains.json           # Chain registry (public RPCs)
├── wallets/
│   └── evm-wallets.json  # Your wallets (gitignored)
├── src/
│   ├── server.js         # Express + Socket.IO web server
│   ├── auth.js           # scrypt auth and session management
│   ├── mint.js           # CLI single mint
│   └── mass-mint.js      # CLI mass mint
└── public/
    ├── index.html        # Web panel UI
    ├── login.html        # Login page
    ├── login.js          # Login logic
    ├── style.css         # Dark theme
    └── app.js            # Frontend logic
```

## Security

- **Password hashing** — scrypt (Node.js built-in, no external dependencies)
- **Session** — 32-byte random token, 24-hour expiry, httpOnly cookie
- **Auth file** — `.auth.json` with `chmod 600` (owner-only read/write)
- **Private keys** — Stored in `wallets/evm-wallets.json` (gitignored)
- **API keys** — Stored in `.env` (gitignored)
- **No secrets in repo** — `.env.example` template only

## Dependencies

| Package | Purpose |
|---------|---------|
| `ethers` | EVM wallet, contract interaction, transaction signing |
| `express` | Web server |
| `socket.io` | Real-time log streaming |
| `cookie-parser` | Session cookie handling |
| `dotenv` | .env loading |
| `p-limit` | Concurrency control for mass mint |
| `cors` | CORS middleware |

## License

MIT
