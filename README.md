# dpMaps

Autonomous, in-house geospatial and routing engine for **Ride** in Bangladesh (Dhaka first), built for operational self-sufficiency.

## Navigate this repo

- **[AGENTS.md](./AGENTS.md)** — agent instructions, clean-room rules, and the Rhizome orchestrator protocol.
- **[docs/plans/000_TOC.md](./docs/plans/000_TOC.md)** — the 16-stage implementation roadmap and stage status matrix.
- **[docs/plans/independent-mapping-engine-concept-paper.md](./docs/plans/independent-mapping-engine-concept-paper.md)** — source-of-truth concept paper (RIDE-CP-2026-GEO-01).

## What it is

dpMaps runs beside the Barikoi vendor API, learns only from first-party Ride trip data, and must be able to take over if Barikoi becomes unavailable. The goal is survival of vendor loss, not cost saving.
