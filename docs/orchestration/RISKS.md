# RISKS.md — dpMaps Risk Register

Project Key: `DPM`
Maintained by: Orchestrator
Format: ID, description, severity (Blocker | High | Medium | Low), owner, mitigation, status (Open | Mitigating | Closed)

| Risk ID | Description | Severity | Owner | Mitigation | Status |
|---|---|---|---|---|---|
| `DPM-R-001` | **Legal Gate Sign-off:** Stage 002 Legal Matrix items (3, 7, 14, 15, 16, 17) require human legal counsel sign-off before Phase 1 telemetry ingestion or shadow learning can begin. | Blocker | Zia / Legal Counsel | Route questions packet to counsel; enforce Phase 0 isolation until written clearance is archived. | Open |
| `DPM-R-002` | **Local Git Tracking Unlinked:** Workspace directory is not yet linked to the existing GitHub repository `https://github.com/dannyzia/dpMap.git`. Local `.git/` working tree must be initialized and pushed to `main`. | High | Zia | Issue DevOps brief to link local workspace to remote repo, configure `.gitignore`, and push `main`. | Closed |
| `DPM-R-003` | **Stale Pin Tool Asset:** `docs/resources/dpmaps-poi-tool.zip` is stale v1. Field survey seeding campaign requires latest v2 build. | High | Zia | Replace zip with latest build in `docs/resources` and extract to `tools/poi-tool`. | Open |
| `DPM-R-004` | **Empty Agent Roster:** ORCHESTRATOR.md §5 roster is unfilled; agents and target tools/models are undefined. | High | Zia | Request roster mapping from Zia before dispatching execution briefs. | Open |
| `DPM-R-005` | **Stage 003 Plan Unpatched:** Stage 003 plan had open review findings (120-day keys, drop `trip_id`, read-time decay, missing tables). | High | Orchestrator | Rev 2.0 patch applied directly per owner instructions; awaiting independent audit. | Closed |
| `DPM-R-006` | **Unverified Technical Facts:** OSRM RAM/latency on real graph, Dhaka OSM completeness, ADM3 thana boundaries, Barikoi exact contractual terms remain unverified. | Medium | Orchestrator / Researcher | Label UNVERIFIED across all plans; schedule targeted benchmarks on real data. | Open |
