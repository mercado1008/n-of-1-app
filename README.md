# N of 1 Precision Formulation

A local-only, single-user precision formulation tool for practitioner-led Chinese herbal medicine dispensing.

## Status

**Active development — Phase 1.** This project is not ready for deployment or public use. Do not expose it to the internet or share credentials without completing further security and compliance work.

## What this does

This app helps a single practitioner:
- Browse and search an ingredients library sourced from a supplier's XLSX export
- Build custom formulations from available ingredients
- Generate patient-facing dispensing documents
- (Future) Integrate with Shopify for order fulfillment

## Local setup

1. Fill in your keys in `.env.local` (scaffold already present — do not commit this file)
2. Drop your source `.xlsx` into `data/library-source/`
3. Run `npm run build:library` to generate the ingredients JSON
4. Run `npm run dev` to start the local server at http://localhost:3000

## Architecture

- **Framework:** Next.js 14 (App Router)
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **Persistence:** SQLite via better-sqlite3 (Phase 2+)
- **AI:** Anthropic Claude API (Phase 2+)
- **Data:** Ingredients library rebuilt from supplier XLSX on demand

## Phase roadmap

| Phase | Focus |
|-------|-------|
| 1 | Project setup + ingredients library transformation |
| 2 | Formulation builder UI |
| 3 | AI-assisted clinical support |
| 4 | Document generation |
| 5 | Shopify integration |
