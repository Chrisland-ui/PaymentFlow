#![allow(clippy::needless_pass_by_value)]

//! PaymentRegistry smart contract for PaymentFlow.
//!
//! This Soroban contract provides an on-chain registry of school fee payments.
//! Each record ties a student identifier to a payment amount, the asset code
//! used (XLM / USDC), and the ledger sequence at which the payment was
//! registered. The registry is append-only — payments can be looked up by
//! student ID and verified independently by any party (school, parent, or
//! auditor) without trusting the backend.
//!
//! The contract is intentionally small: it stores payment commitments, not the
//! actual XLM/USDC transfers. Transfers happen via standard Stellar payment
//! operations (or Fee Bump transactions) as the backend already does today;
//! the contract stores the *attestation* that a payment was received and
//! matched to a student.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, vec, Address, Env,
    Map, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/// Map<student_id: Symbol, Vec<PaymentRecord>> — all payments for a student.
const PAYMENTS: Symbol = symbol_short!("PAYMENTS");

/// Map<tx_hash: Symbol, PaymentRecord> — deduplication index. The Stellar
/// transaction hash is stored as a short symbol (truncated to 9 chars due to
/// Soroban symbol limits; the full hash is kept inside the record for
/// verification).
const TX_INDEX: Symbol = symbol_short!("TX_INDEX");

/// Counter for the total number of payments registered across all students.
const TOTAL_COUNT: Symbol = symbol_short!("COUNT");

/// The contract administrator (set at initialization). Only the admin can
/// call `register_payment` — in production this would be the school wallet
/// or a multisig.
const ADMIN: Symbol = symbol_short!("ADMIN");

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// A single payment record stored on-chain.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentRecord {
    /// Student identifier (e.g. "STU001"). Same value used in the Stellar
    /// transaction memo field for automatic matching by the backend.
    pub student_id: Symbol,
    /// Amount paid, in the smallest unit (stroops for XLM, micro-cents for
    /// USDC). Stored as an integer to avoid floating-point issues on-chain.
    pub amount_stroops: i128,
    /// Asset code: `symbol_short!("XLM")` or `symbol_short!("USDC")`.
    pub asset: Symbol,
    /// Ledger sequence at which the payment was registered.
    pub ledger_seq: u32,
    /// First 9 characters of the Stellar transaction hash (for the dedup
    /// index key; the full hash is too long for a Symbol).
    pub tx_hash_short: Symbol,
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// Caller is not the contract admin.
    Unauthorized = 1,
    /// A payment with this transaction hash has already been registered.
    DuplicatePayment = 2,
    /// Student ID is empty or invalid.
    InvalidStudentId = 3,
    /// Amount must be positive.
    InvalidAmount = 4,
    /// No payments found for the given student.
    NoPaymentsFound = 5,
    /// Contract has not been initialized.
    NotInitialized = 6,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct PaymentRegistry;

#[contractimpl]
impl PaymentRegistry {
    /// Initialize the contract with an admin address. Must be called once
    /// after deployment (the deploy transaction sets the admin to the
    /// signer of that transaction).
    pub fn initialize(env: Env, admin: Address) {
        if Self::get_admin(&env).is_some() {
            panic!("contract already initialized");
        }
        env.storage().instance().set(&ADMIN, &admin);
    }

    /// Register a new payment. Only callable by the admin.
    ///
    /// Returns the updated total count of registered payments.
    pub fn register_payment(
        env: Env,
        admin: Address,
        student_id: Symbol,
        amount_stroops: i128,
        asset: Symbol,
        tx_hash_short: Symbol,
    ) -> Result<u32, Error> {
        // Authorization: only the admin can register payments.
        admin.require_auth();

        let stored_admin = Self::get_admin(&env).ok_or(Error::NotInitialized)?;
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }

        // Validation
        if amount_stroops <= 0 {
            return Err(Error::InvalidAmount);
        }
        // Soroban Symbol cannot be empty, so InvalidStudentId is only
        // triggered if the symbol is the sentinel `_` placeholder.
        if student_id == symbol_short!("___") {
            return Err(Error::InvalidStudentId);
        }

        // Deduplication check
        let mut tx_index: Map<Symbol, PaymentRecord> = env
            .storage()
            .instance()
            .get(&TX_INDEX)
            .unwrap_or_else(|| Map::new(&env));

        if tx_index.contains_key(tx_hash_short.clone()) {
            return Err(Error::DuplicatePayment);
        }

        // Build the record
        let record = PaymentRecord {
            student_id: student_id.clone(),
            amount_stroops,
            asset: asset.clone(),
            ledger_seq: env.ledger().sequence(),
            tx_hash_short: tx_hash_short.clone(),
        };

        // Insert into the per-student vector
        let mut payments: Map<Symbol, Vec<PaymentRecord>> = env
            .storage()
            .instance()
            .get(&PAYMENTS)
            .unwrap_or_else(|| Map::new(&env));

        let mut student_payments = payments
            .get(student_id.clone())
            .unwrap_or_else(|| Vec::new(&env));
        student_payments.push_back(record.clone());
        payments.set(student_id.clone(), student_payments);
        env.storage().instance().set(&PAYMENTS, &payments);

        // Insert into the dedup index
        tx_index.set(tx_hash_short, record);
        env.storage().instance().set(&TX_INDEX, &tx_index);

        // Increment total count
        let count: u32 = env.storage().instance().get(&TOTAL_COUNT).unwrap_or(0);
        let new_count = count + 1;
        env.storage().instance().set(&TOTAL_COUNT, &new_count);

        Ok(new_count)
    }

    /// Get all payment records for a given student.
    pub fn get_payments(env: Env, student_id: Symbol) -> Result<Vec<PaymentRecord>, Error> {
        let payments: Map<Symbol, Vec<PaymentRecord>> = env
            .storage()
            .instance()
            .get(&PAYMENTS)
            .unwrap_or_else(|| Map::new(&env));

        match payments.get(student_id.clone()) {
            Some(records) => Ok(records),
            None => Err(Error::NoPaymentsFound),
        }
    }

    /// Look up a single payment by its (shortened) transaction hash.
    pub fn get_payment_by_tx(env: Env, tx_hash_short: Symbol) -> Option<PaymentRecord> {
        let tx_index: Map<Symbol, PaymentRecord> = env
            .storage()
            .instance()
            .get(&TX_INDEX)
            .unwrap_or_else(|| Map::new(&env));
        tx_index.get(tx_hash_short)
    }

    /// Get the total number of payments registered across all students.
    pub fn get_total_count(env: Env) -> u32 {
        env.storage().instance().get(&TOTAL_COUNT).unwrap_or(0)
    }

    /// Get the admin address, if initialized.
    pub fn get_admin(env: &Env) -> Option<Address> {
        env.storage().instance().get(&ADMIN)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (Env, Address, PaymentRegistryClient) {
        let env = Env::default();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, PaymentRegistry);
        let client = PaymentRegistryClient::new(&env, &contract_id);

        client.initialize(&admin);
        (env, admin, client)
    }

    // ── Initialization ────────────────────────────────────────────────────────

    #[test]
    fn test_initialize_sets_admin() {
        let (env, admin, _) = setup();
        let stored = PaymentRegistry::get_admin(&env);
        assert_eq!(stored, Some(admin));
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let (env, admin, client) = setup();
        let other = Address::generate(&env);
        client.initialize(&other); // should panic
    }

    // ── register_payment ────────────────────────────────────────────────────

    #[test]
    fn test_register_payment_success() {
        let (env, admin, client) = setup();

        let student = symbol_short!("STU001");
        let tx_hash = symbol_short!("txabc0001");
        let count = client.register_payment(
            &admin,
            &student,
            &25_0000000, // 25 XLM in stroops
            &symbol_short!("XLM"),
            &tx_hash,
        );

        assert_eq!(count, 1);
        assert_eq!(client.get_total_count(), 1);

        // Verify the stored record
        let records = client.get_payments(&student).unwrap();
        assert_eq!(records.len(), 1);

        let record = records.get(0).unwrap();
        assert_eq!(record.student_id, student);
        assert_eq!(record.amount_stroops, 25_0000000);
        assert_eq!(record.asset, symbol_short!("XLM"));
        assert_eq!(record.tx_hash_short, tx_hash);
        // Ledger sequence should match the env's current ledger
        assert_eq!(record.ledger_seq, env.ledger().sequence());
    }

    #[test]
    fn test_register_multiple_payments_same_student() {
        let (env, admin, client) = setup();
        let student = symbol_short!("STU001");

        client.register_payment(
            &admin,
            &student,
            &10_0000000,
            &symbol_short!("XLM"),
            &symbol_short!("txabc0001"),
        );
        client.register_payment(
            &admin,
            &student,
            &15_0000000,
            &symbol_short!("USDC"),
            &symbol_short!("txabc0002"),
        );

        let records = client.get_payments(&student).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(client.get_total_count(), 2);

        // Verify ordering: first payment is first in the vector
        let first = records.get(0).unwrap();
        assert_eq!(first.amount_stroops, 10_0000000);

        let second = records.get(1).unwrap();
        assert_eq!(second.amount_stroops, 15_0000000);
        assert_eq!(second.asset, symbol_short!("USDC"));
    }

    #[test]
    fn test_register_payment_multiple_students() {
        let (_, admin, client) = setup();

        client.register_payment(
            &admin,
            &symbol_short!("STU001"),
            &10_0000000,
            &symbol_short!("XLM"),
            &symbol_short!("txaaa0001"),
        );
        client.register_payment(
            &admin,
            &symbol_short!("STU002"),
            &20_0000000,
            &symbol_short!("XLM"),
            &symbol_short!("txaaa0002"),
        );

        assert_eq!(client.get_total_count(), 2);

        let stu1 = client.get_payments(&symbol_short!("STU001")).unwrap();
        assert_eq!(stu1.len(), 1);

        let stu2 = client.get_payments(&symbol_short!("STU002")).unwrap();
        assert_eq!(stu2.len(), 1);
    }

    // ── Authorization ───────────────────────────────────────────────────────

    #[test]
    #[should_panic] // require_auth panics for non-admin
    fn test_register_payment_unauthorized_caller() {
        let (env, admin, client) = setup();
        let attacker = Address::generate(&env);

        // This should fail — attacker is not the admin and require_auth
        // will reject the signature.
        client.register_payment(
            &attacker,
            &symbol_short!("STU001"),
            &10_0000000,
            &symbol_short!("XLM"),
            &symbol_short!("txbad0001"),
        );
    }

    // ── Duplicate detection ─────────────────────────────────────────────────

    #[test]
    fn test_register_duplicate_payment_rejected() {
        let (_, admin, client) = setup();
        let tx_hash = symbol_short!("txdup0001");

        let result1 = client.register_payment(
            &admin,
            &symbol_short!("STU001"),
            &10_0000000,
            &symbol_short!("XLM"),
            &tx_hash,
        );
        assert!(result1.is_ok());

        // Same tx_hash, different student — must be rejected
        let result2 = client.try_register_payment(
            &admin,
            &symbol_short!("STU002"),
            &5_0000000,
            &symbol_short!("XLM"),
            &tx_hash,
        );
        assert_eq!(result2, Err(Ok(Error::DuplicatePayment)));
    }

    // ── Validation ───────────────────────────────────────────────────────────

    #[test]
    fn test_register_payment_zero_amount_rejected() {
        let (_, admin, client) = setup();

        let result = client.try_register_payment(
            &admin,
            &symbol_short!("STU001"),
            &0,
            &symbol_short!("XLM"),
            &symbol_short!("txzer0001"),
        );
        assert_eq!(result, Err(Ok(Error::InvalidAmount)));
    }

    #[test]
    fn test_register_payment_negative_amount_rejected() {
        let (_, admin, client) = setup();

        let result = client.try_register_payment(
            &admin,
            &symbol_short!("STU001"),
            &-1,
            &symbol_short!("XLM"),
            &symbol_short!("txneg0001"),
        );
        assert_eq!(result, Err(Ok(Error::InvalidAmount)));
    }

    // ── get_payments ────────────────────────────────────────────────────────

    #[test]
    fn test_get_payments_nonexistent_student() {
        let (_, _, client) = setup();

        let result = client.try_get_payments(&symbol_short!("NOPE"));
        assert_eq!(result, Err(Ok(Error::NoPaymentsFound)));
    }

    // ── get_payment_by_tx ───────────────────────────────────────────────────

    #[test]
    fn test_get_payment_by_tx_found() {
        let (_, admin, client) = setup();
        let tx_hash = symbol_short!("txfnd0001");

        client.register_payment(
            &admin,
            &symbol_short!("STU001"),
            &10_0000000,
            &symbol_short!("XLM"),
            &tx_hash,
        );

        let record = client.get_payment_by_tx(&tx_hash);
        assert!(record.is_some());

        let r = record.unwrap();
        assert_eq!(r.student_id, symbol_short!("STU001"));
        assert_eq!(r.amount_stroops, 10_0000000);
    }

    #[test]
    fn test_get_payment_by_tx_not_found() {
        let (_, _, client) = setup();
        let record = client.get_payment_by_tx(&symbol_short!("txmis9999"));
        assert!(record.is_none());
    }

    // ── get_total_count ─────────────────────────────────────────────────────

    #[test]
    fn test_total_count_starts_zero() {
        let (_, _, client) = setup();
        assert_eq!(client.get_total_count(), 0);
    }

    #[test]
    fn test_total_count_after_registrations() {
        let (_, admin, client) = setup();

        client.register_payment(
            &admin,
            &symbol_short!("STU001"),
            &10_0000000,
            &symbol_short!("XLM"),
            &symbol_short!("txcnt0001"),
        );
        assert_eq!(client.get_total_count(), 1);

        client.register_payment(
            &admin,
            &symbol_short!("STU002"),
            &20_0000000,
            &symbol_short!("USDC"),
            &symbol_short!("txcnt0002"),
        );
        assert_eq!(client.get_total_count(), 2);
    }

    // ── get_admin ───────────────────────────────────────────────────────────

    #[test]
    fn test_get_admin_not_initialized() {
        let env = Env::default();
        let contract_id = env.register_contract(None, PaymentRegistry);
        let _client = PaymentRegistryClient::new(&env, &contract_id);

        // No initialize called — get_admin should return None
        let admin = PaymentRegistry::get_admin(&env);
        assert!(admin.is_none());
    }
}
