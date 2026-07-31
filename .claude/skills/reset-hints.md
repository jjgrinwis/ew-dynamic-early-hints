---
name: reset-hints
description: Manage EdgeKV hints (show/reset/delete)
---

# Manage EdgeKV Hints

Interact with the EdgeKV storage and cache for the early hints system.

## Available Operations

### 1. Show Current State

Display all hints currently stored in EdgeKV `all_hints` item:

```bash
./manage-hints.sh --show-content
```

Shows formatted JSON with all entries, their filenames, and Last-Modified timestamps.

### 2. Full Reset

Delete the `all_hints` item and purge all cache tags:

```bash
./manage-hints.sh --full-reset
```

**When to use**:
- After changing static hints configuration
- After modifying Property Manager match patterns
- Major system updates
- Starting fresh discovery

**What it does**:
1. Deletes EdgeKV `all_hints` item
2. Purges cache tag: `early-hints`
3. Clears all discovered dynamic hints

### 3. Delete Specific Key

Remove a single key from the `all_hints` object:

```bash
./manage-hints.sh --delete-key <logical-key>
```

**Examples**:
- `./manage-hints.sh --delete-key example.css`
- `./manage-hints.sh --delete-key ruxitagentjs`

**When to use**:
- Removing a specific hint that's no longer needed
- Forcing re-discovery of a single resource
- Targeted cleanup without full reset

**What it does**:
1. Reads current `all_hints` object
2. Removes specified key
3. Writes updated object back
4. Purges cache tag: `hints-<key>`

## Workflow

**Ask user which operation**:
1. Show current hints
2. Full reset (confirm first - destructive)
3. Delete specific key (prompt for key name)

Then execute the corresponding command and report results.

## Notes

- EdgeKV propagation takes ~10 seconds (eventually consistent)
- Full reset requires cache purge propagation (30-60 seconds)
- Always run after deploying static hints changes
