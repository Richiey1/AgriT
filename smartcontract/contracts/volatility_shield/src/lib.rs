#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, String, Symbol, Vec,
};

// ─── Storage Keys ────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    VycCounter,
    Vyc(u64),            // VYC id → VycRecord
    FarmerVycs(Address), // farmer address → Vec<u64> (their VYC ids)
}

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[contracttype]
pub enum VycStatus {
    Active,    // Certificate minted, awaiting harvest
    Redeemed,  // Farmer claimed payout / loan settled
    Expired,   // Harvest window passed without redemption
    Cancelled, // Admin-cancelled (e.g., verified fraud)
}

/// Verifiable Yield Certificate — the core primitive of AgriTrust.
///
/// Represents a farmer's expected harvest value, backed by verified
/// proof-of-activity (seed purchase, planting log, etc.).
///
/// score:           AgriTrust credit score at time of minting (0-100).
///                  Integrates with FluxID scoring via the backend.
/// expected_yield:  Expected harvest value in micro-USDC (6 decimal places).
///                  e.g. 50_000_000 = 50 USDC.
/// crop:            Short crop identifier: "MAIZE", "COCOA", "SOYBEAN" etc.
/// region:          ISO 3166-2 region code, e.g. "NG-LA" (Lagos, Nigeria).
/// activity_hash:   SHA-256 of the proof-of-activity payload (receipt hash,
///                  anchor transaction id, etc.) for on-chain auditability.
#[contracttype]
pub struct VycRecord {
    pub id: u64,
    pub farmer: Address,
    pub score: u32,
    pub expected_yield: i128,
    pub crop: Symbol,
    pub region: Symbol,
    pub activity_hash: String, // 64-char hex SHA-256
    pub status: VycStatus,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Errors returned by minting (issue #7).
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MintError {
    NotInitialized = 1,
    Unauthorized = 2,
    ScoreOutOfRange = 3,
    InvalidYield = 4,
    InvalidActivityHash = 5,
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct AgriTrust;

#[contractimpl]
impl AgriTrust {
    // ── Admin ──────────────────────────────────────────────────────────────

    pub fn init(env: Env, admin: Address) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::VycCounter, &0u64);
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("Not initialised"))
    }

    pub fn transfer_admin(env: Env, admin: Address, new_admin: Address) {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("Not initialised"));
        if admin != stored {
            panic!("Unauthorized");
        }
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    // ── Mint VYC ───────────────────────────────────────────────────────────

    /// Mint a new Verifiable Yield Certificate for a farmer.
    ///
    /// Called by the AgriTrust backend after:
    ///   1. Farmer logs a verified proof-of-activity (seed purchase from anchor).
    ///   2. Backend computes the credit score (via FluxID scoring engine).
    ///   3. Backend verifies the activity hash against the anchor transaction.
    ///
    /// admin:           The protocol admin keypair (backend-controlled).
    /// farmer:          The farmer's Stellar wallet address.
    /// score:           Credit score at time of minting (0-100).
    /// expected_yield:  Expected harvest value in micro-USDC.
    /// crop:            Crop identifier symbol.
    /// region:          Region code symbol.
    /// activity_hash:   SHA-256 hex of the proof-of-activity payload.
    #[allow(clippy::too_many_arguments)]
    pub fn mint_vyc(
        env: Env,
        admin: Address,
        farmer: Address,
        score: u32,
        expected_yield: i128,
        crop: Symbol,
        region: Symbol,
        activity_hash: String,
    ) -> Result<u64, MintError> {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(MintError::NotInitialized)?;

        if admin != stored_admin {
            return Err(MintError::Unauthorized);
        }

        if score > 100 {
            return Err(MintError::ScoreOutOfRange);
        }

        if expected_yield <= 0 {
            return Err(MintError::InvalidYield);
        }

        // activity_hash must be a 64-char lowercase hex SHA-256 string
        // (see hashActivityPayload in the backend scoring service).
        // Length gate FIRST: copy_into_slice requires an exactly-sized
        // buffer, so a short/long hash must be rejected before copying.
        // (hex chars are ASCII so bytes == chars here)
        if activity_hash.len() != 64 {
            return Err(MintError::InvalidActivityHash);
        }
        let mut hash_bytes = [0u8; 64];
        activity_hash.copy_into_slice(&mut hash_bytes);
        if !hash_bytes
            .iter()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err(MintError::InvalidActivityHash);
        }

        // Increment the global VYC counter to get a unique ID.
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::VycCounter)
            .unwrap_or(0u64);
        let new_id = id + 1;
        env.storage().instance().set(&DataKey::VycCounter, &new_id);

        let now = env.ledger().timestamp();

        let vyc = VycRecord {
            id: new_id,
            farmer: farmer.clone(),
            score,
            expected_yield,
            crop: crop.clone(),
            region: region.clone(),
            activity_hash,
            status: VycStatus::Active,
            created_at: now,
            updated_at: now,
        };

        env.storage().persistent().set(&DataKey::Vyc(new_id), &vyc);

        // Append this VYC id to the farmer's list.
        let mut farmer_vycs: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::FarmerVycs(farmer.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        farmer_vycs.push_back(new_id);
        env.storage()
            .persistent()
            .set(&DataKey::FarmerVycs(farmer.clone()), &farmer_vycs);

        // Emit a VycMinted event for off-chain indexers (liquidity providers,
        // insurance oracles, etc.) to observe new certificates.
        env.events().publish(
            (Symbol::new(&env, "vyc_minted"), farmer.clone()),
            (new_id, score, expected_yield, crop, region, now),
        );

        Ok(new_id)
    }

    // ── Query ──────────────────────────────────────────────────────────────

    pub fn get_vyc(env: Env, id: u64) -> Option<VycRecord> {
        env.storage().persistent().get(&DataKey::Vyc(id))
    }

    /// Token-style metadata: human-readable certificate name.
    pub fn name(env: Env) -> String {
        String::from_str(&env, "AgriTrust Yield Certificate")
    }

    /// Token-style metadata: ticker symbol for the VYC asset.
    pub fn symbol(env: Env) -> Symbol {
        Symbol::new(&env, "VYC")
    }

    /// Full VYC records for one farmer — the frontend "My certificates" list
    /// uses this so it renders without N+1 `get_vyc` reads per id.
    pub fn get_farmer_vyc_records(env: Env, farmer: Address) -> Vec<VycRecord> {
        let ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::FarmerVycs(farmer))
            .unwrap_or_else(|| Vec::new(&env));

        let mut records = Vec::new(&env);
        for id in ids.iter() {
            if let Some(vyc) = env.storage().persistent().get(&DataKey::Vyc(id)) {
                records.push_back(vyc);
            }
        }
        records
    }

    /// All VYC IDs for a given farmer address.
    pub fn get_farmer_vycs(env: Env, farmer: Address) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::FarmerVycs(farmer))
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn get_vyc_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::VycCounter)
            .unwrap_or(0)
    }

    // ── Status Updates ─────────────────────────────────────────────────────

    /// Update the status of a VYC (e.g. mark as Redeemed after payout).
    /// Only admin can call this — farmer cannot self-redeem to prevent fraud.
    pub fn update_status(env: Env, admin: Address, id: u64, new_status: VycStatus) {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("Not initialised"));

        if admin != stored_admin {
            panic!("Unauthorized");
        }

        let mut vyc: VycRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Vyc(id))
            .unwrap_or_else(|| panic!("VYC not found"));

        if vyc.status != VycStatus::Active {
            panic!("Can only update Active VYCs");
        }

        let now = env.ledger().timestamp();
        vyc.status = new_status;
        vyc.updated_at = now;

        env.storage().persistent().set(&DataKey::Vyc(id), &vyc);

        // Emit a status-change event for liquidity providers and insurance oracles.
        env.events()
            .publish((Symbol::new(&env, "vyc_status"), id), (new_status, now));
    }
}

mod test;
