#!/usr/bin/env bash
#
# manage-hints.sh - Management script for Dynamic Early Hints system
#
# Purpose:
# - View current hints stored in EdgeKV
# - Delete specific hint entries
# - Clear EdgeKV group (removes all dynamic hints)
# - Purge cache by tag (invalidates cached responses with early hints)
# - Purge a specific object by URL path (for first-time warmup/reset)
#
# Important Notes:
# - Make sure to set AKAMAI_EDGEGRID_SECTION, AKAMAI_EDGEKV_NAMESPACE, and optionally
#   AKAMAI_ACCOUNT_SWITCH_KEY environment variables before running this script!
#
# Usage:
#   ./manage-hints.sh --show-content       # Display current EdgeKV hints (read-only)
#   ./manage-hints.sh --delete-key <name>  # Delete single EdgeKV key + purge based on cache-tag
#   ./manage-hints.sh --full-reset         # Clear EdgeKV + purge all early hints based on cache-tag
#   ./manage-hints.sh --purge-path <url>  # Purge one object by full URL
#
# When to run:
# - --show-content: Anytime (view current state, debugging)
# - --delete-key: Remove a specific hint, force re-discovery of a resource
# - --full-reset: After changing static hints or Property Manager patterns
# - --purge-path <url>: When you want to purge a specific resource (after a new deployment to invalidate object which doesn't have cache-tag yet)

set -euo pipefail

# Configuration from hints-reader package.json
EDGERC_SECTION="${AKAMAI_EDGEGRID_SECTION:-default}"
ACCOUNT_SWITCH_KEY="${AKAMAI_ACCOUNT_SWITCH_KEY:-}"
EDGEKV_NAMESPACE="${AKAMAI_EDGEKV_NAMESPACE:-CHANGE_ME}"
EDGEKV_GROUP="earlyHints"
NETWORK="staging"  # or "production"

# Cache tag configuration
BROAD_TAG="early-hints"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

function log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

function log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

function log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

function akamai_common_args() {
    local args=(--section "$EDGERC_SECTION")

    # Only include account switch key when explicitly set.
    if [[ -n "$ACCOUNT_SWITCH_KEY" ]]; then
        args+=(--accountkey "$ACCOUNT_SWITCH_KEY")
    fi

    echo "${args[@]}"
}

function usage() {
    cat <<EOF
Usage: $0 [OPTION]

Reset Dynamic Early Hints system by clearing EdgeKV and purging cache.

OPTIONS:
    --full-reset              Clear entire EdgeKV group and purge all early hints
    --delete-key <key-name>   Delete specific key from all_hints and purge its cache tag
    --purge-path <url>        Purge one object by full URL (not tag/cpcode)
    --show-content            Display current EdgeKV content (read-only)
    -h, --help               Show this help message

EXAMPLES:
    # Set env vars for this shell session
    export AKAMAI_EDGEGRID_SECTION=default
    export AKAMAI_EDGEKV_NAMESPACE=mynamespace
    export AKAMAI_ACCOUNT_SWITCH_KEY='B-M-XXXX:1-YYYY'

    # Or set env vars for a single command
    AKAMAI_EDGEGRID_SECTION=default AKAMAI_EDGEKV_NAMESPACE=mynamespace AKAMAI_ACCOUNT_SWITCH_KEY='B-M-XXXX:1-YYYY' $0 --show-content

    # Run without account switch key
    AKAMAI_EDGEGRID_SECTION=default AKAMAI_EDGEKV_NAMESPACE=mynamespace $0 --show-content

    # Show current hints in EdgeKV
    $0 --show-content

    # Full reset (use after config changes)
    $0 --full-reset

    # Delete specific entry
    $0 --delete-key example.css

    # Purge a single object by full URL
    $0 --purge-path https://www.example.com/static/example.css?v=10

NOTES:
    - Full reset should be run after any Property Manager configuration change
    - Delete key is useful for targeted cleanup or rollback
    - All hints are stored in a single EdgeKV item "all_hints" for efficiency
    - AKAMAI_EDGEGRID_SECTION, AKAMAI_EDGEKV_NAMESPACE, and AKAMAI_ACCOUNT_SWITCH_KEY can be provided via environment variables
    - If AKAMAI_ACCOUNT_SWITCH_KEY is unset/empty, the script does not pass --accountkey
    - Network is currently set to: $NETWORK
    - Edit this script to change network or credentials

EOF
    exit 0
}

function check_dependencies() {
    local missing=()

    if ! command -v akamai &> /dev/null; then
        missing+=("akamai")
    fi

    if ! command -v jq &> /dev/null; then
        missing+=("jq")
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        log_error "Missing required commands: ${missing[*]}"
        log_error "Install with: brew install akamai jq"
        exit 1
    fi
}

function purge_by_tag() {
    local tag=$1
    log_info "Purging cache by tag: $tag on $NETWORK"

    # Fast Purge by cache tag
    # Note: Requires Fast Purge API credentials in .edgerc
    local purge_response
    local common_args
    common_args=$(akamai_common_args)

    purge_response=$(akamai purge invalidate \
        $common_args \
        tag "$tag" \
        --network "$NETWORK" 2>&1) || {
        log_error "Fast Purge failed: $purge_response"
        return 1
    }

    log_info "Purge initiated successfully"
}

function purge_by_path() {
    local purge_url=${1:-}

    if [[ -z "$purge_url" ]]; then
        log_error "--purge-path requires a full URL"
        usage
    fi

    if [[ ! "$purge_url" =~ ^https?:// ]]; then
        log_error "--purge-path expects a full URL (http:// or https://)"
        exit 1
    fi

    log_info "Purging cache by URL path on $NETWORK"
    log_info "URL: $purge_url"

    local purge_response
    local common_args
    common_args=$(akamai_common_args)

    purge_response=$(akamai purge invalidate \
        $common_args \
        url "$purge_url" \
        --network "$NETWORK" 2>&1) || {
        log_error "URL purge failed: $purge_response"
        return 1
    }

    log_info "Path-based purge initiated successfully"
}

function delete_edgekv_item() {
    local item=$1
    log_info "Deleting EdgeKV item: $item"

    local common_args
    common_args=$(akamai_common_args)

    akamai edgekv delete item \
        $common_args \
        "$NETWORK" "$EDGEKV_NAMESPACE" "$EDGEKV_GROUP" "$item" || {
        log_error "Failed to delete EdgeKV item: $item"
        return 1
    }

    log_info "EdgeKV item deleted: $item"
}

function list_edgekv_items() {
    log_info "Listing EdgeKV items in group: $EDGEKV_GROUP"

    local common_args
    common_args=$(akamai_common_args)

    akamai edgekv list items \
        $common_args \
        "$NETWORK" "$EDGEKV_NAMESPACE" "$EDGEKV_GROUP" || {
        log_error "Failed to list EdgeKV items"
        return 1
    }
}

function show_edgekv_content() {
    log_info "EdgeKV Content for network: $NETWORK"
    log_info "Namespace: $EDGEKV_NAMESPACE, Group: $EDGEKV_GROUP"
    echo ""

    local common_args
    common_args=$(akamai_common_args)

    # Read the single all_hints item
    echo -e "${GREEN}=== All Hints (all_hints) ===${NC}"
    local all_hints_content
    all_hints_content=$(akamai edgekv read item \
        $common_args \
        "$NETWORK" "$EDGEKV_NAMESPACE" "$EDGEKV_GROUP" "all_hints" 2>&1 | \
        tail -1) || {
        echo -e "${YELLOW}No hints found${NC}"
        echo ""
        return 0
    }

    if [[ "$all_hints_content" == "{}" ]]; then
        echo -e "${YELLOW}No hints stored${NC}"
        echo ""
        return 0
    fi

    # Parse and display each key in the all_hints object
    local keys
    keys=$(echo "$all_hints_content" | jq -r 'keys[]' 2>/dev/null)

    if [[ -z "$keys" ]]; then
        echo -e "${YELLOW}No hints stored${NC}"
        echo ""
        return 0
    fi

    local count=$(echo "$keys" | wc -l | tr -d ' ')
    echo -e "${YELLOW}Total hints: ${count}${NC}"
    echo ""

    # Display each hint
    while IFS= read -r key; do
        if [[ -n "$key" ]]; then
            echo -e "${GREEN}Key: ${NC}$key"
            local hint_data
            hint_data=$(echo "$all_hints_content" | jq --arg key "$key" '.[$key]' 2>/dev/null)

            if [[ -n "$hint_data" ]]; then
                echo -e "${YELLOW}Content:${NC}"
                echo "$hint_data" | jq . | sed 's/^/  /'
            fi
            echo ""
        fi
    done <<< "$keys"
}

function full_reset() {
    log_warn "Starting FULL RESET of Dynamic Early Hints system"
    log_warn "This will:"
    log_warn "  1. Delete ALL items in EdgeKV group: $EDGEKV_GROUP"
    log_warn "  2. Purge ALL cached responses with tag: $BROAD_TAG"

    read -p "Continue? (yes/no): " confirm
    if [[ "$confirm" != "yes" ]]; then
        log_info "Aborted by user"
        exit 0
    fi

    # List current items
    log_info "Current EdgeKV items:"
    list_edgekv_items

    # Delete the single all_hints item
    log_info "Deleting all_hints item"
    delete_edgekv_item "all_hints" || {
        log_warn "all_hints might not exist, continuing..."
    }

    # Purge cache by broad tag
    purge_by_tag "$BROAD_TAG"

    log_info "Full reset complete!"
    log_info "Next steps:"
    log_info "  1. Deploy updated EdgeWorker if code changed"
    log_info "  2. Test with cache miss to populate new hints"
}

function delete_key() {
    local key=$1

    if [[ -z "$key" ]]; then
        log_error "--delete-key requires a key name"
        usage
    fi

    log_info "Deleting key: $key"
    log_info "This will:"
    log_info "  1. Remove key from all_hints object"
    log_info "  2. Purge cache with tag: hints-$key"

    # Read current all_hints
    log_info "Reading all_hints..."
    local common_args
    common_args=$(akamai_common_args)

    local all_hints
    all_hints=$(akamai edgekv read item \
        $common_args \
        "$NETWORK" "$EDGEKV_NAMESPACE" "$EDGEKV_GROUP" "all_hints" 2>&1 | \
        tail -1) || {
        log_error "Failed to read all_hints"
        exit 1
    }

    # Remove the key from the object
    log_info "Removing key from all_hints..."
    local new_hints
    new_hints=$(echo "$all_hints" | jq --arg key "$key" 'del(.[$key])' 2>/dev/null)

    if [[ -z "$new_hints" ]]; then
        log_error "Failed to remove key from all_hints"
        exit 1
    fi

    # Write back
    log_info "Writing updated all_hints..."
    akamai edgekv write text \
        $common_args \
        "$NETWORK" "$EDGEKV_NAMESPACE" "$EDGEKV_GROUP" "all_hints" \
        "$new_hints" || {
        log_error "Failed to update all_hints"
        exit 1
    }

    # Purge the specific tag
    purge_by_tag "hints-${key}"

    log_info "Key deleted: $key"
}

# Main script
check_dependencies

case "${1:-}" in
    --full-reset)
        full_reset
        ;;
    --delete-key)
        delete_key "${2:-}"
        ;;
    --show-content)
        show_edgekv_content
        ;;
    --purge-path)
        purge_by_path "${2:-}"
        ;;
    -h|--help)
        usage
        ;;
    *)
        log_error "Invalid option: ${1:-}"
        usage
        ;;
esac
