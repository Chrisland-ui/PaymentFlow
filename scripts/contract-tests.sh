#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# contract-tests.sh — Compile, deploy, and smoke-test the PaymentRegistry
# Soroban contract against a local Stellar standalone node.
#
# This script is designed to run both locally and inside the GitHub Actions
# "contract-tests" CI job. It:
#   1. Compiles the Rust contract to Wasm (skipped if a cached .wasm exists)
#   2. Starts a Stellar Quickstart standalone node in Docker
#   3. Creates a test account and funds it with the root account
#   4. Deploys the compiled contract
#   5. Initializes the contract with the test account as admin
#   6. Runs a series of smoke-test invocations against the deployed contract
#   7. Tears down the Docker container
#
# Prerequisites:
#   - Docker running
#   - Rust + cargo installed (or rustup)
#   - stellar CLI installed (cargo install --locked soroban-cli)
#
# Usage:
#   ./scripts/contract-tests.sh           # full run
#   SKIP_DOCKER=true ./scripts/contract-tests.sh  # reuse a running node
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACT_DIR="$ROOT_DIR/contracts/payment-registry"
WASM_PATH="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/payment_registry.wasm"

DOCKER_IMAGE="stellar/quickstart:testing"
CONTAINER_NAME="stellar-standalone"
RPC_PORT=8000
RPC_URL="http://localhost:${RPC_PORT}"
NETWORK_PASSPHRASE="Standalone Network ; February 2017"
# The root account secret key for the standalone network. This is well-known
# and only used on the local standalone node — never on testnet or mainnet.
ROOT_SECRET="SC5O7VZUMI6Q5G2L3F3Q3F3Q3F3Q3F3Q3F3Q3F3Q3F3Q3F3Q3F3Q"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date +%H:%M:%S)] WARN:${NC} $*"; }
err()  { echo -e "${RED}[$(date +%H:%M:%S)] ERROR:${NC} $*" >&2; }

# ── Cleanup on exit ──────────────────────────────────────────────────────────

cleanup() {
  if [ "${SKIP_DOCKER:-false}" = "true" ]; then
    return
  fi
  log "Stopping Stellar standalone container..."
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
}
trap cleanup EXIT

# ── Step 0: Verify prerequisites ─────────────────────────────────────────────

check_prereqs() {
  log "Checking prerequisites..."

  if ! command -v docker &>/dev/null; then
    err "docker is not installed"
    exit 1
  fi

  if ! command -v cargo &>/dev/null; then
    err "cargo (Rust) is not installed. Install via: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
  fi

  if ! command -v stellar &>/dev/null; then
    err "stellar CLI is not installed. Install via: cargo install --locked soroban-cli"
    exit 1
  fi

  log "Prerequisites OK."
}

# ── Step 1: Compile the contract ────────────────────────────────────────────

compile_contract() {
  if [ -f "$WASM_PATH" ]; then
    log "Found cached WASM at $WASM_PATH — skipping compilation."
    return
  fi

  log "Compiling PaymentRegistry contract to Wasm..."
  cd "$CONTRACT_DIR"

  # Add the wasm32 target if not already installed
  rustup target add wasm32-unknown-unknown 2>/dev/null || true

  cargo build --release --target wasm32-unknown-unknown 2>&1

  if [ ! -f "$WASM_PATH" ]; then
    err "WASM not found after build at $WASM_PATH"
    exit 1
  fi

  log "Contract compiled: $WASM_PATH"
}

# ── Step 2: Start local Stellar node ────────────────────────────────────────

start_node() {
  if [ "${SKIP_DOCKER:-false}" = "true" ]; then
    log "SKIP_DOCKER=true — assuming a node is already running at $RPC_URL"
    return
  fi

  log "Starting Stellar standalone node via Docker..."
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

  docker run -d \
    --name "$CONTAINER_NAME" \
    -p "${RPC_PORT}:8000" \
    "$DOCKER_IMAGE" \
    standalone \
    --enable-soroban-rpc \
    2>&1

  log "Waiting for node to be ready..."
  local max_wait=120
  local elapsed=0
  while [ $elapsed -lt $max_wait ]; do
    if curl -sf "$RPC_URL" &>/dev/null; then
      log "Stellar node is ready."
      return
    fi
    elapsed=$((elapsed + 3))
    sleep 3
    printf '.'
  done
  echo ""
  err "Stellar node did not become ready within ${max_wait}s"
  docker logs "$CONTAINER_NAME"
  exit 1
}

# ── Step 3: Create and fund a test account ───────────────────────────────────

setup_account() {
  log "Creating test account..."

  # Generate a new keypair for testing
  TEST_SECRET=$(stellar keys generate --no-fund --network standalone 2>&1 | grep -oP 'Secret Key: \K\S+' || true)
  # Fall back to a deterministic test key if the above fails
  if [ -z "$TEST_SECRET" ]; then
    TEST_SECRET="SC5O7VZUMI6Q5G2L3F3Q3F3Q3F3Q3Q3F3Q3F3Q3F3Q3F3Q3F3Q3"
  fi

  # Use the stellar CLI to fund the test account from the root account
  # On the standalone network, the root account is automatically funded
  log "Funding test account from root account..."

  # Create a test identity using the CLI
  stellar keys add test-admin --secret-key "$TEST_SECRET" --network standalone 2>/dev/null || true

  # Fund via friendbot or root account
  local test_public
  test_public=$(stellar keys show test-admin -- pubkey 2>/dev/null || echo "")

  if [ -z "$test_public" ]; then
    # Fallback: use the root account directly
    warn "Could not generate a new keypair; using root account for testing."
    stellar keys add root-account --secret-key "$ROOT_SECRET" --network standalone 2>/dev/null || true
    TEST_SECRET="$ROOT_SECRET"
  fi

  log "Test account configured."
}

# ── Step 4: Deploy the contract ─────────────────────────────────────────────

deploy_contract() {
  log "Deploying PaymentRegistry contract..."

  # Deploy the .wasm and create a contract instance
  CONTRACT_ID=$(stellar contract deploy \
    --wasm "$WASM_PATH" \
    --source-account test-admin \
    --network standalone \
    -- \
    2>&1 | tail -1)

  if [ -z "$CONTRACT_ID" ]; then
    err "Contract deployment failed."
    exit 1
  fi

  log "Contract deployed at: $CONTRACT_ID"
}

# ── Step 5: Initialize the contract ──────────────────────────────────────────

initialize_contract() {
  log "Initializing contract..."

  local admin_pubkey
  admin_pubkey=$(stellar keys show test-admin -- pubkey 2>/dev/null || echo "")

  if [ -z "$admin_pubkey" ]; then
    err "Could not determine admin public key."
    exit 1
  fi

  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source-account test-admin \
    --network standalone \
    -- \
    initialize \
    --admin "$admin_pubkey"

  log "Contract initialized with admin: $admin_pubkey"
}

# ── Step 6: Run smoke tests ──────────────────────────────────────────────────

run_smoke_tests() {
  log "Running smoke tests against deployed contract..."
  local failures=0

  # Test 1: Verify total_count starts at 0
  log "Test 1: get_total_count should return 0"
  count=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --network standalone \
    -- \
    get_total_count 2>/dev/null | tr -d '"' || echo "ERROR")

  if [ "$count" = "0" ] || [ "$count" = "0u32" ]; then
    log "  ✓ get_total_count = 0"
  else
    err "  ✗ get_total_count expected 0, got '$count'"
    failures=$((failures + 1))
  fi

  # Test 2: Register a payment
  log "Test 2: register_payment"
  reg_result=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source-account test-admin \
    --network standalone \
    -- \
    register_payment \
    --admin "$(stellar keys show test-admin -- pubkey 2>/dev/null)" \
    --student_id "STU001" \
    --amount_stroops 250000000 \
    --asset "XLM" \
    --tx_hash_short "txsmoke01" \
    2>&1 || echo "ERROR")

  if echo "$reg_result" | grep -qi error; then
    err "  ✗ register_payment failed: $reg_result"
    failures=$((failures + 1))
  else
    log "  ✓ register_payment succeeded"
  fi

  # Test 3: Verify total_count is now 1
  log "Test 3: get_total_count should return 1"
  count=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --network standalone \
    -- \
    get_total_count 2>/dev/null | tr -d '"' || echo "ERROR")

  if [ "$count" = "1" ] || [ "$count" = "1u32" ]; then
    log "  ✓ get_total_count = 1"
  else
    err "  ✗ get_total_count expected 1, got '$count'"
    failures=$((failures + 1))
  fi

  # Test 4: Look up the payment by tx hash
  log "Test 4: get_payment_by_tx"
  tx_result=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --network standalone \
    -- \
    get_payment_by_tx \
    --tx_hash_short "txsmoke01" \
    2>&1 || echo "ERROR")

  if echo "$tx_result" | grep -qi error; then
    err "  ✗ get_payment_by_tx failed: $tx_result"
    failures=$((failures + 1))
  else
    log "  ✓ get_payment_by_tx returned a record"
  fi

  # Test 5: Duplicate payment should fail
  log "Test 5: register duplicate payment should fail"
  dup_result=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source-account test-admin \
    --network standalone \
    -- \
    register_payment \
    --admin "$(stellar keys show test-admin -- pubkey 2>/dev/null)" \
    --student_id "STU002" \
    --amount_stroops 100000000 \
    --asset "XLM" \
    --tx_hash_short "txsmoke01" \
    2>&1 || echo "EXPECTED_FAILURE")

  if echo "$dup_result" | grep -qi "DuplicatePayment\|EXPECTED_FAILURE\|error"; then
    log "  ✓ Duplicate payment correctly rejected"
  else
    err "  ✗ Duplicate payment was not rejected: $dup_result"
    failures=$((failures + 1))
  fi

  # Summary
  echo ""
  if [ $failures -eq 0 ]; then
    log "All smoke tests passed! (5/5)"
    return 0
  else
    err "Smoke tests failed: $failures/5"
    return 1
  fi
}

# ── Main ────────────────────────────────────────────────────────────────────

main() {
  log "Starting contract tests..."

  check_prereqs
  compile_contract
  start_node
  setup_account
  deploy_contract
  initialize_contract
  run_smoke_tests

  log "Contract tests completed successfully."
}

main "$@"
