# Stellar Smart Contract Guide: Building with Soroban 🌟

Welcome to the comprehensive guide for building smart contracts on the Stellar network using **Soroban**. This guide is designed to help you understand the "why" and "how" of Stellar's ecosystem and get you shipping decentralized applications quickly.

## 1. The Stellar Vision 🌍

**What is Stellar?**
Stellar is a decentralized, open network created to move money and store value. Its primary mission is **financial inclusion**—connecting the world's financial systems to ensure that money can move as easily as email.

**Why was it built?**
- **Asset Issuance:** Stellar makes it incredibly easy to issue digital representations of real-world assets (fiat currencies, stocks, gold).
- **Speed & Cost:** Transactions settle in seconds (3-5s) and cost fractions of a cent ($0.00001).
- **The "Anchor" Model:** It connects banks, payment systems, and people, acting as a bridge between traditional finance (TradFi) and blockchain.

**Enter Soroban** 🧠
Soroban is the smart contract platform added to Stellar. While Stellar's base layer handles payments and asset issuance efficiently, **Soroban** enables Turing-complete programmability. It allows you to build DeFi protocols, DAOs, and complex logic that interact seamlessly with Stellar's existing assets.

---

## 2. Setting Up Your Environment 🛠️

Soroban contracts are written in **Rust** and compiled to **WebAssembly (Wasm)**.

### Prerequisites
1.  **Rust & Cargo:** The primary language and package manager.
    ```bash
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
    rustup target add wasm32-unknown-unknown
    ```
2.  **Soroban CLI:** Your swiss-army knife for building and deploying.
    ```bash
    cargo install --locked soroban-cli
    ```
3.  **Freighter Wallet:** The recommended browser extension for Stellar apps.

### 2.1 Funding Your Wallet (The Faucet) 🚰

You cannot deploy contracts without testnet tokens (XLM).

1.  **Generate Identity:**
    ```bash
    soroban config identity generate alice
    ```
2.  **Fund Alice:**
    Use Friendbot to fund your new identity on Testnet:
    ```bash
    curl "https://friendbot.stellar.org/?addr=$(soroban config identity address alice)"
    ```
    *Alternatively, go to the [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=test) to create and fund accounts via UI.*

---

## 3. Core Concepts & Architecture 🏗️

### A. The Host Environment
Soroban contracts run in a sandboxed "Host Environment". Unlike Ethereum where you have direct access to almost everything, Soroban restricts access to ensure scalability.
- **No Standard Lib:** You cannot use standard Rust libraries (`std`). You must use the `soroban-sdk` crate (`no_std`).
- **Host Functions:** You interact with the blockchain (storage, crypto, other contracts) via specific host functions provided by the SDK.

### B. Storage (State)
Soroban has a unique storage model. You don't just "declare variables". You specifically choose where data lives:
- **Temporary Storage:** Cheapest, deleted after a short time (good for oracle data).
- **Instance Storage:** Tied to the contract instance, lives as long as the contract does (good for admin keys).
- **Persistent Storage:** Expensive, permanent data (good for user balances).

### C. Authentication (Auth)
Forget `msg.sender`. Soroban uses a powerful **Auth Framework**.
- You don't ask "who called this?".
- You ask "**Does this address authorize this action?**"
- `address.require_auth()` prompts the user (wallet) to sign the transaction.

---

## 4. Hello World: Your First Contract 👋

Create a new project:
```bash
soroban contract init hello_world
cd hello_world
```

**`src/lib.rs`**:
```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, vec, Env, Symbol, Vec};

#[contract]
pub struct HelloContract;

#[contractimpl]
impl HelloContract {
    pub fn hello(env: Env, to: Symbol) -> Vec<Symbol> {
        vec![&env, symbol_short!("Hello"), to]
    }
}
```

### Key Takeaways:
- `#[contract]`: Marks the struct as a smart contract.
- `#[contractimpl]`: Where you define the public functions.
- `Env`: The environment object passed to every function, giving access to the blockchain.

---

## 5. Testing (The "Superpower") 🧪

Soroban allows you to run contracts **natively** on your machine without a local blockchain. It's incredibly fast.

**`src/test.rs`**:
```rust
#![cfg(test)]
use super::*;
use soroban_sdk::Env;

#[test]
fn test() {
    let env = Env::default();
    let contract_id = env.register_contract(None, HelloContract);
    let client = HelloContractClient::new(&env, &contract_id);

    let words = client.hello(&symbol_short!("Dev"));
    assert_eq!(words, vec![&env, symbol_short!("Hello"), symbol_short!("Dev")]);
}
```
Run it with `cargo test`.

---

## 6. Deployment & Interaction 🚀

1.  **Build:**
    ```bash
    soroban contract build
    ```
2.  **Deploy (Testnet):**
    ```bash
    soroban contract deploy \
        --wasm target/wasm32-unknown-unknown/release/hello_world.wasm \
        --source alice \
        --network testnet
    ```
3.  **Invoke:**
    ```bash
    soroban contract invoke \
        --id <CONTRACT_ID> \
        --source alice \
        --network testnet \
        -- \
        hello \
        --to Dev
    ```

## 7. Resources & Tools 📚
- **Stellar Laboratory:** Explore the network state.
- **Soroban Docs:** [developers.stellar.org/docs](https://developers.stellar.org/docs)
- **Rust Book:** Essential for mastering the language quirks.

---

## 8. AgriTrust-Specific Notes (the VYC Contract) 🌾

AgriTrust's `agritrust_vyc` contract mints **Verifiable Yield Certificates (VYCs)** — 
tokenized records of a farmer's expected harvest value. Key patterns:

- **Admin-Centric Minting:** Only the protocol admin can mint or update a VYC, preventing self-minting and fraud.
- **Persistent State:** VYCs, the global counter, and per-farmer ID lists live in persistent storage.
- **Cross-Chain Scoring:** The `score` field (0-100) is produced off-chain by the FluxID scoring engine.
- **Status Lifecycle:** `Active → Redeemed | Expired | Cancelled` (only `Active` VYCs can be updated).

### The `agritrust_vyc` Contract Structure (contracts/volatility_shield)

```rust
#[contract]
pub struct AgriTrust;

#[contractimpl]
impl AgriTrust {
    pub fn init(env: Env, admin: Address) { /* set Admin + VycCounter */ }

    pub fn mint_vyc(
        env: Env,
        admin: Address,       // requires admin auth
        farmer: Address,      // the farmer's Stellar address
        score: u32,           // FluxID credit score (0-100)
        expected_yield: i128, // expected harvest value in micro-USDC
        crop: Symbol,         // "MAIZE", "COCOA", "SOYBEAN"...
        region: Symbol,       // region code, e.g. "NGLA"
        activity_hash: String, // SHA-256 of the proof-of-activity payload
                               // MUST be 64-char lowercase hex — invalid input
                               // returns MintError::InvalidActivityHash
    ) -> Result<u64, MintError> { /* mints a VYC and returns its id */ }

    pub fn name(env: Env) -> String {
        // "AgriTrust Yield Certificate"
    }
    pub fn symbol(env: Env) -> Symbol {
        // "VYC"
    }
    pub fn get_vyc(env: Env, id: u64) -> Option<VycRecord> { /* read one VYC */ }
    pub fn get_farmer_vycs(env: Env, farmer: Address) -> Vec<u64> { /* ids per farmer */ }
    /// Full records for a farmer — lets the frontend render "My certificates"
    /// with a single call instead of N+1 `get_vyc` reads.
    pub fn get_farmer_vyc_records(env: Env, farmer: Address) -> Vec<VycRecord> { /* full VycRecords */ }
    pub fn get_vyc_count(env: Env) -> u64 { /* total minted */ }

    pub fn update_status(env: Env, admin: Address, id: u64, new_status: VycStatus) {
        // Active -> Redeemed/Expired/Cancelled (admin only, prevents fraud)
    }
}
```

### Input Validation & Errors (issue #7)

`mint_vyc` returns `Result<u64, MintError>` instead of panicking:

| Variant | When |
|---|---|
| `NotInitialized` | Contract has no admin set |
| `Unauthorized` | Caller is not the stored admin |
| `ScoreOutOfRange` | Score above 100 |
| `InvalidYield` | Expected yield ≤ 0 |
| `InvalidActivityHash` | Hash is not 64-char lowercase hex |

Clients should use the generated `try_mint_vyc(...)` which returns the error
instead of aborting.

### Deploy & invoke outline
```bash
soroban contract build
soroban contract deploy --wasm target/wasm32-unknown-unknown/release/agritrust_vyc.wasm --source alice --network testnet
```
Initialize with the admin, then the backend calls `mint_vyc` after proof-of-activity verification.

---

*Happy Building! 🌾*
