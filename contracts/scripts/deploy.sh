#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(dirname "$SCRIPT_DIR")"
CIRCUITS_DIR="$(cd "$CONTRACTS_DIR/../../circuits" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

# Load environment from circuits/.env.development
ENV_FILE="$CIRCUITS_DIR/.env.development"
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}Error: $ENV_FILE not found${NC}"
    echo "Copy circuits/.env.development.example and fill in values"
    exit 1
fi

source "$ENV_FILE"

if [ -z "$PRIVATE_KEY" ]; then
    echo -e "${RED}Error: PRIVATE_KEY not set in $ENV_FILE${NC}"
    exit 1
fi

if [ -z "$BASE_SEPOLIA_RPC_URL" ]; then
    echo -e "${RED}Error: BASE_SEPOLIA_RPC_URL not set in $ENV_FILE${NC}"
    exit 1
fi

# Derive deployer address to use as service wallet
SERVICE_WALLET=$(cast wallet address "$PRIVATE_KEY" 2>/dev/null)
if [ -z "$SERVICE_WALLET" ]; then
    echo -e "${RED}Error: Failed to derive wallet address from PRIVATE_KEY${NC}"
    exit 1
fi

echo ""
echo "============================================================"
echo -e " ${BLUE}Deploying OpenStoaRecordBoard to Base Sepolia${NC}"
echo "============================================================"
echo -e " Service Wallet: $SERVICE_WALLET"
echo -e " RPC URL: $BASE_SEPOLIA_RPC_URL"
echo ""

cd "$CONTRACTS_DIR"

# Set env for forge script
export SERVICE_WALLET_ADDRESS="$SERVICE_WALLET"
export BASE_SEPOLIA_RPC_URL

VERIFY_FLAGS=""
if [ -n "$ETHERSCAN_API_KEY" ]; then
    VERIFY_FLAGS="--verify --etherscan-api-key $ETHERSCAN_API_KEY --verifier-url https://api.etherscan.io/v2/api?chainid=84532"
fi

forge script script/Deploy.s.sol \
    --rpc-url "$BASE_SEPOLIA_RPC_URL" \
    --private-key "$PRIVATE_KEY" \
    --broadcast \
    $VERIFY_FLAGS

echo ""
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN} OpenStoaRecordBoard deployed to Base Sepolia!${NC}"
echo -e "${GREEN}============================================================${NC}"
echo -e " Broadcast: broadcast/Deploy.s.sol/84532/run-latest.json"
echo -e " Explorer: https://sepolia.basescan.org"
