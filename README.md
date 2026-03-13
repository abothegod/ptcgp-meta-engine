# PTCGP Meta Intelligence Engine

A live tier list and deck builder for **Pokémon TCG Pocket**, powered by real tournament data from the Limitless competitive platform.

**Live site:** https://abothegod.github.io/ptcgp-meta-engine/

---

## What It Does

- Pulls win rate and meta share data from thousands of real tournament player records via the Limitless API
- Scores every archetype across 6 strategic dimensions
- Assigns S/A/B/C tiers from composite score
- Generates optimal 20-card decklists for the top 20 archetypes
- Updates automatically on the 1st and 15th of every month via GitHub Actions

---

## How the Scoring Works

Each archetype is scored 0–100 across 6 dimensions:

| Dimension | Weight | What it measures |
|---|---|---|
| Win Rate | 40% | Raw tournament win rate |
| Meta Share | 20% | Log-weighted popularity across all tournaments |
| Type Coherence | 10% | Penalty for multi-energy requirements |
| Evolution Lines | 10% | Full Stage-1/Stage-2 chains present |
| Setup Speed | 10% | Estimated turns to first meaningful attack |
| Disruption Value | 10% | Red Card / Sabrina / stall potential |

**Tier thresholds:**

| Tier | Score |
|---|---|
| S | 75+ |
| A | 60+ |
| B | 45+ |
| C | <45 |

---

## Data Sources

| Source | Role |
|---|---|
| [Limitless API](https://play.limitlesstcg.com/api/tournaments?game=POCKET) | Win rates + meta share aggregated from the last 50 standard-format tournaments (no API key required) |
| [ptcgpocket.gg](https://ptcgpocket.gg/tier-list/) | Editorial tier overrides when available |

Win rates and meta share are computed from raw player records — not imported from any pre-ranked list. A minimum of 10 appearances across tournaments is required for an archetype to qualify.

---

## Deck Construction Rules

Every generated decklist follows these constraints:

1. Primary win-condition attacker (EX/Mega preferred), 2 copies
2. Full evolution line if Stage 2 (2-2-2 Basic → Stage 1 → Stage 2)
3. Trainer core: 2× Poké Ball + 2× Professor's Research (always)
4. Type-relevant supporter: Giovanni / Misty / Sabrina (2 copies)
5. Draw engine: 2× Copycat or 2× Sightseer
6. Disruption: Red Card for Dark/Psychic decks
7. Flex fillers to guarantee exactly 20 cards

---

## Auto-Update Pipeline

The GitHub Action runs `update-meta.js` which:

1. Fetches the last 50 POCKET tournaments from the Limitless API
2. Filters out non-standard formats (No-EX, Mono, Singleton, Draft)
3. Pulls standings for each tournament and aggregates per-deck win/loss records
4. Scores, ranks, and builds 20-card lists for the top 20 archetypes
5. Patches `CARD_REGISTRY` and `META_SNAPSHOT` directly into the HTML file
6. Commits and pushes the updated file

You can also trigger a manual run from the **Actions** tab with an optional dry-run mode that previews changes without committing.

---

## Running Locally

Requires Node 18+. No dependencies — uses only Node built-ins and native `fetch`.

```bash
node update-meta.js
```

This fetches live data, scores archetypes, and overwrites `ptcgp-meta-engine.html` in place.

---

## Project Structure

```
ptcgp-meta-engine.html        # Self-contained frontend (HTML + CSS + JS)
update-meta.js                # Data pipeline and deck builder
.github/workflows/
  update-meta.yml             # Bi-weekly GitHub Actions workflow
```

---

## Optional: Limitless API Key

The pipeline works without an API key. If Limitless ever gates the `/standings` endpoint behind authentication, add a `LIMITLESS_API_KEY` secret in your repository settings — the workflow is already wired to pass it through.
