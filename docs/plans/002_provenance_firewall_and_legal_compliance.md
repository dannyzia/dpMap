# Stage 002: Provenance Firewall & Legal Compliance Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-002 (Revision 2.2 — Rigorous Clean-Room Architecture)  
**Stage:** 2 of 16 (Clean-Room Governance & Legal Architecture)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§3, §3.1–3.4, §11.2)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **NotDone**  

---

## 1. Executive Summary & Objective

Commercial mapping vendors (specifically Google and Barikoi) maintain Terms of Service that strictly restrict customers from capturing, storing, caching, or reverse-engineering their API responses to create competing geospatial or routing databases. Furthermore, commercial providers may plant **canary entries** (fictitious streets, deliberate misspellings, or synthetic coordinates) to identify and prosecute unauthorized database scraping.

Stage 002 establishes an end-to-end **Clean-Room Provenance Architecture** to:
1. Isolate vendor API communications inside a typed client wrapper that prevents raw vendor payloads from ever reaching application code, logs, or gazetteers.
2. Provide an ephemeral, server-side `resolveVendorSelection(temp_client_id)` using atomic Redis `GETDEL` (120s TTL) that returns destination coordinates exclusively to dispatch navigation, failing safely without storage fallback.
3. Establish a dedicated **Vendor-Derived Data Inventory** that isolates operational vendor data into `ride_vendor_data` (keyed by `ride_id`) and grants `dpmaps_worker` explicit column grants strictly on first-party columns, revoking all access to vendor tables and receipts.
4. Systematically identify and block all **Persistent Sinks** (application loggers, real Sentry hooks, host-and-status-only proxy logging for outbound vendor calls, Postgres `log_parameter_max_length = 0`, tracing span attributes, heap snapshots, warehouse exports, and disabled managed-Redis snapshots/replicas).
5. Implement a cryptographically sound **Provenance Architecture** (`FieldProvenance`) covering canonical names, Bengali text, categories, point types, search aliases, and parent place IDs, anchored via a Merkle tree root and append-only event ledger.
6. Provide a practical **Contamination Incident Runbook** where quarantine pauses ingestion and learning, supported by canary detection and pre-agreed counsel forensic-hold protocols.
7. Formalize a comprehensive **Legal Review Matrix** enforcing a mandatory legal gate: **Phase 1 start requires counsel resolution on critical gating items**.

---

## 2. The First-Party Data Isolation Boundary

The system maintains a strict architectural and network separation between external commercial APIs and Ride's learning assets:

```
                                [ RIDE BACKEND ]
                                        │
             ┌──────────────────────────┴──────────────────────────┐
             ▼                                                     ▼
┌──────────────────────────┐                             ┌──────────────────────────┐
│  ISOLATED VENDOR WRAPPER │                             │    FIRST-PARTY CLIENT    │
│  (Ephemeral Memory Only) │                             │        TELEMETRY         │
│ • Barikoi / Google SDK   │                             │ • Rider typed characters │
│ • Private raw payload    │                             │ • Driver exit GPS fix    │
│ • Emits minimal DTO:     │                             │ • Snapped odometer trace │
│   - numbers / enums only │                             │ • Real elapsed seconds   │
│   - zero free-text logs  │                             │ • Pin Tool survey data   │
│   - coordinates withheld │                             │ • Verified merchant pins │
└────────────┬─────────────┘                             └────────────┬─────────────┘
             │                                                        │
             │ (Strictly Dropped at Wrapper Boundary)                  │ (Permitted Ingestion)
             ▼                                                        ▼
       [ LOG / DISK ] ◄────────────── [ FIREWALL ] ─────────────► [ dpMaps LEDGER ]
         (BLOCKED)                                                (Clean-Room Asset)
```

### 2.1 Permissible First-Party Assets vs. Restricted Third-Party IP

| Data Element | Classification | Permitted Use & Architectural Boundary |
|---|:---:|---|
| **Rider pre-autocomplete typed query** | First-Party | Captured on mobile client handset at the moment of selection; powers Layer 1 relevance. |
| **Driver physical GPS exit coordinates** | First-Party | Handset GPS fix at trip completion; powers Layer 2 spatial clustering. |
| **Elapsed trip duration & driven odometer** | First-Party | Vehicle telemetry recorded upon trip arrival; powers dynamic speed calibration. |
| **Landmark Pin Tool field surveys** | First-Party | Clean-room field observations backed by digital contributor warranties; powers `public_pois`. |
| **Merchant storefront coordinates** | First-Party | Directly onboarded via Merchant Portal under clean-room warranty; powers `public_pois`. |
| **OpenStreetMap road geometry** | Open Source | Maintained in isolated `dpmaps.osm_pois` under ODbL attribution; never commingled into `public_pois`. |
| **Vendor formatted address strings** | Third-Party | Ephemeral client display and receipts only; **strictly barred from dpMaps gazetteers**. |
| **Vendor place identifiers (`place_id`)** | Third-Party | Ephemeral session transit only; **strictly barred from relational foreign keys or gazetteer indexes**. |
| **Vendor destination coordinates** | Third-Party | Ephemeral dispatch navigation only via `ride_vendor_data`; **strictly barred from `public_pois` spatial tables**. |
| **Vendor quoted distance / duration** | Third-Party | Retained only in transactional fare records; **learning pipeline records only computed error % vs. GPS**. |
| **Vendor route polylines** | Third-Party | Rendered ephemerally on handset view only; **dropped from database persistence**. |

### 2.2 Client-Side Query Capture Invariant
Streaming keystroke events (`onTextChanged` on every character) is strictly prohibited as an invasive telemetry practice and privacy risk. Instead, the mobile client captures **only the final typed string at the exact moment of suggestion selection** (or search submission).

**Non-Negotiable Client Rules:**
1. **Selection-Moment Capture Only:** Telemetry captures the search buffer only when the user explicitly taps a suggestion or executes a search. Continuous keystroke streams are never sent, buffered, or stored.
2. **Buffer Length Cap:** The typed string buffer is strictly capped at a maximum of 80 characters.
3. **Bengali Digit Normalization & PII Filtering:**
   Before regex evaluation, the client normalizes the input:
   - Converts Bengali numerals (`০-৯`, U+09E6–U+09EF) to standard ASCII digits (`0-9`).
   - Strips whitespace, hyphens (`-`), and dots (`.`).
   - Evaluates the normalized string: **any digit run of 9 or more consecutive digits (`\d{9,}`)** (catching all local mobile formats: `01712345678`, `+8801712345678`, `017 1234 5678`, `01712-345678`, `+880 1712 345678`, and Bengali-digit forms like `০১৭১২৩৪৫৬৭৮`) or email patterns (`/@[\w.-]+\.\w+/`) is classified as sensitive PII.
   - If any sensitive pattern is detected, the **entire buffer is immediately discarded** and omitted from telemetry.
4. **App-Controlled Autofill Separation:** Auto-populating the search input with the vendor's full address string upon selection is **application behavior** (not operating system behavior). The mobile search controller maintains an isolated variable holding exclusively the user's typed string, discarding any vendor-populated text from search evaluation telemetry.

---

## 3. Vendor-Derived Data Inventory & Access Controls

In ride-hailing operations, certain operational tables must retain vendor coordinates and quotes for dispatch, billing, customer receipts, and taxation. The architecture resolves the tension between operational dispatch and IP clean-room boundaries through physical table separation:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        VENDOR-DERIVED DATA INVENTORY & FIREWALL                        │
├───────────────────┬───────────────────────────────┬────────────────────────────────────┤
│ Database Table    │ Permitted Columns             │ Access Policy & Firewall Rule      │
├───────────────────┼───────────────────────────────┼────────────────────────────────────┤
│ `ride_vendor_data`│ • `ride_id` (UUID, PK, FK)    │ • Dedicated vendor isolation table │
│                   │ • `vendor_dest_lat` (FLOAT)   │ • READ: Billing, Dispatch, Support │
│                   │ • `vendor_dest_lng` (FLOAT)   │ • FORBIDDEN: `dpmaps_worker` has   │
│                   │ • `vendor_quoted_dist_m` (INT)│   ZERO access permissions.         │
│                   │ • `vendor_quoted_dur_s` (INT) │ • Dropped: polyline and dest_name  │
│                   │                               │   omitted unless required by tax.  │
├───────────────────┼───────────────────────────────┼────────────────────────────────────┤
│ `orders` / `rides`│ • Strictly first-party columns│ • Operational ride metadata.       │
│                   │   (`id`, `status`, `fare_bdt`,│ • `dpmaps_worker` gets EXPLICIT    │
│                   │    `dropoff_lat`, `dropoff_lng`, column-level grants only on first-│
│                   │    `elapsed_seconds`,         │   party operational fields.        │
│                   │    `created_at`)              │                                    │
├───────────────────┼───────────────────────────────┼────────────────────────────────────┤
│ `ride_receipts`   │ • `dropoff_neighborhood_text` │ • Generated from first-party ADM3. │
│                   │ • `vendor_address_text`       │ • [UNVERIFIED: confirm if tax law  │
│                   │                               │   requires verbatim vendor text].  │
│                   │                               │ • Zero access by mapping jobs.     │
├───────────────────┼───────────────────────────────┼────────────────────────────────────┤
│ Redis Cache       │ • `autocomplete:vendor:*`     │ • Volatile in-memory only (TTL 24h)│
│                   │   (Ephemeral vendor results)  │ • Managed Redis snapshots &        │
│                   │ • `vendor:resolve:*` (TTL 120s) replicas explicitly disabled.     │
└───────────────────┴───────────────────────────────┴────────────────────────────────────┘
```

### 3.1 Strict Column-Level Grants for Learning Jobs
Relying on "zero SELECT on vendor columns" inside a shared table is vulnerable: if a developer adds a new vendor-derived column to `orders`, it becomes readable by default.

To eliminate this vulnerability:
1. **Physical Table Isolation:** All vendor-derived data is extracted into the dedicated `ride_vendor_data` table.
2. **Explicit Column Grants on `orders`:** The background database role (`dpmaps_worker`) used by mapping workers (`evidenceDecayWorker`, `winnerSelectionWorker`, `aliasClusteringWorker`) is granted `SELECT` privileges exclusively on a specified whitelist of first-party columns, using standardized naming (`elapsed_seconds`):
   ```sql
   -- Explicit column grants: adding a new column to orders does NOT expose it
   REVOKE ALL ON orders FROM dpmaps_worker;
   GRANT SELECT (id, status, created_at, dropoff_lat, dropoff_lng, elapsed_seconds) 
     ON orders TO dpmaps_worker;

   -- Zero access to vendor-derived tables or customer receipts
   REVOKE ALL ON ride_vendor_data FROM dpmaps_worker;
   REVOKE ALL ON ride_receipts FROM dpmaps_worker;
   ```
3. **Receipt Text Strategy & Tax Verification:**
   Ride receipts are generated using sovereign first-party boundary polygon labels (e.g. ADM3 Upazila/Neighborhood names from `geoBoundaries-BGD-ADM3.geojson`). Storing commercial vendor address strings on receipts is marked as `[UNVERIFIED - confirm with tax counsel whether Bangladesh NBR/VAT regulations mandate verbatim vendor address text]`. If tax regulations do not mandate vendor strings, vendor text is omitted from receipts entirely.

---

## 4. Vendor Client Wrapper Design

Allowlist sanitizers that inspect field names on arbitrary JSON fail because third-party data easily leaks through free-text fields (`error_message`, `url_path`, `endpoint`) or bare coordinate arrays `[lng, lat]`.

Stage 002 replaces payload sanitizers with an **Isolated Vendor Client Wrapper**:
1. The raw HTTP response never leaves the wrapper function.
2. The wrapper parses the vendor payload in ephemeral volatile memory.
3. The wrapper emits only a strictly typed, minimal Data Transfer Object (DTO) containing numbers and enums.
4. Suggestions returned to the mobile app are **response-only**; free text and polylines are never logged, stored in databases, or forwarded to telemetry.
5. Ephemeral destination coordinates are stored in Redis (`vendor:resolve:*`, TTL 120s) and retrieved by dispatch via atomic `GETDEL`. If expired or missing, dispatch fails safely with user reselection (no storage fallback).

```typescript
// utils-server/vendorClientWrapper.ts

export interface SafeVendorRouteResult {
  distance_meters: number;
  duration_seconds: number;
  polyline?: string; // Delivered only to handset ephemeral view
  provider: 'barikoi' | 'google';
  status: 'OK' | 'NO_ROUTE' | 'TIMEOUT' | 'ERROR';
  http_status: number;
  latency_ms: number;
}

export interface SafeVendorSuggestion {
  temp_client_id: string; // Ephemeral random token (UUID v4)
  display_name: string;   // For immediate mobile UI rendering only
  secondary_text: string;
  category: string;
  // Notice: Coordinates and vendor place IDs are strictly omitted from this DTO
}

/**
 * Server-side suggestion fetcher that calls vendor autocomplete API,
 * ephemerally caches destination coordinates with 120s TTL, and emits safe DTOs.
 */
export async function fetchSafeVendorSuggestions(
  query: string,
  userLoc?: { lat: number; lng: number }
): Promise<SafeVendorSuggestion[]> {
  const rawVendorResults = await callPrivateVendorAutocompleteApi(query, userLoc);
  if (!rawVendorResults || !Array.isArray(rawVendorResults.predictions)) {
    return [];
  }

  const safeSuggestions: SafeVendorSuggestion[] = [];

  for (const item of rawVendorResults.predictions) {
    const tempClientId = crypto.randomUUID();

    // Ephemerally store coordinates strictly for dispatch resolution (TTL: 120s)
    await ephemeralCache.set(
      `vendor:resolve:${tempClientId}`,
      JSON.stringify({ lat: Number(item.latitude), lng: Number(item.longitude) }),
      'EX',
      120
    );

    // Safe DTO strictly withholds coordinates and vendor place IDs
    safeSuggestions.push({
      temp_client_id: tempClientId,
      display_name: String(item.title || item.name || ''),
      secondary_text: String(item.address || item.sub_title || ''),
      category: String(item.category || 'general')
    });
  }

  return safeSuggestions;
}

/**
 * Server-side resolution turning a rider's tapped suggestion into destination coordinates.
 * Uses atomic Redis GETDEL to ensure single-use reading; exposed ONLY to the dispatch module.
 * If null (TTL expired or token reused), rider must re-select; system NEVER falls back to storage.
 */
export async function resolveVendorSelection(
  temp_client_id: string
): Promise<{ lat: number; lng: number } | null> {
  // Atomic get-and-delete prevents concurrent duplicate consumption
  const raw = await ephemeralCache.getdel(`vendor:resolve:${temp_client_id}`);
  if (!raw) {
    // Token expired (>120s) or already consumed.
    // Recovery policy: Client displays re-selection prompt. Zero database or log fallback.
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return { lat: parsed.lat, lng: parsed.lng };
  } catch {
    return null;
  }
}

export async function executeBarikoiRoute(
  origin: { lat: number; lng: number },
  dest: { lat: number; lng: number },
  timeoutMs: number
): Promise<SafeVendorRouteResult | null> {
  const start = Date.now();
  let httpStatus = 0;

  try {
    const rawResponse = await callPrivateVendorApi(origin, dest, timeoutMs);
    httpStatus = rawResponse.status;
    const latencyMs = Date.now() - start;

    if (!rawResponse.ok || !rawResponse.data) {
      logSafeDiagnostics('barikoi', 'ERROR', httpStatus, latencyMs);
      return null;
    }

    const parsed = rawResponse.data;
    logSafeDiagnostics('barikoi', 'OK', httpStatus, latencyMs);

    return {
      distance_meters: Number(parsed.distance) || 0,
      duration_seconds: Math.round(Number(parsed.duration) || 0),
      polyline: typeof parsed.route === 'string' ? parsed.route : undefined,
      provider: 'barikoi',
      status: 'OK',
      http_status: httpStatus,
      latency_ms: latencyMs
    };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const status = err.name === 'AbortError' ? 'TIMEOUT' : 'ERROR';
    logSafeDiagnostics('barikoi', status, httpStatus || 500, latencyMs);
    return null;
  }
}

/**
 * Diagnostic logger emitting ONLY wrapper-generated enums and numbers.
 * Free-text fields (error_message, url_path, endpoint, request_id) are strictly dropped.
 */
function logSafeDiagnostics(
  provider: string,
  status: string,
  httpStatus: number,
  latencyMs: number
): void {
  logger.info({
    event: 'external_vendor_call',
    provider,
    status,
    http_status: httpStatus,
    latency_ms: latencyMs
  });
}
```

> [!IMPORTANT]
> **CRITICAL INVARIANT: Suggestion Text & Polylines are Response-Only**  
> 1. The `display_name` and `secondary_text` strings in `SafeVendorSuggestion` are generated solely to populate the ephemeral client HTTP response for UI presentation. They are **never logged**, **never stored in any database**, and **never included in search telemetry, evaluation datasets, or gazetteer pipelines**.  
> 2. The `polyline` string in `SafeVendorRouteResult` is delivered strictly within the ephemeral HTTP route response to the driver/rider handset view. It is **never persisted in database tables**, **never stored in routing training sets**, and **never written to application logs**.

---

## 5. Comprehensive Sink Auditing & Blocking Rules

Vendor data can leak into persistent storage through multiple auxiliary infrastructure sinks:

| Infrastructure Sink | Risk of Leakage | Mandatory Enforcement & Blocking Rule |
|---|---|---|
| **1. Application Loggers (Winston/Pino)** | Dumping request/response objects on errors | Banned. Wrapper logs only `{ provider, status, http_status, latency_ms }`. |
| **2. HTTP Client Interceptors (Axios)** | Default interceptors logging request URLs and parameters | URL/header/body debug logging disabled; query parameters stripped. |
| **3. APM & Error Trackers (Sentry/Datadog)** | Capturing HTTP breadcrumbs with coordinates and URLs | Real SDK hooks `beforeBreadcrumb` and `beforeSend` implemented to scrub URLs, coordinates, and vendor tokens. |
| **4. Egress Proxy Logs (NGINX/Envoy)** | `access.log` recording full URI with place IDs in path | For outbound vendor calls, proxy logging records **strictly host and status code** (`$upstream_addr`, `$status`); `$uri`, `$request`, and paths are omitted. |
| **5. Database Slow-Query Logs** | Logging raw SQL statements with address strings | Parameterized queries only; set `log_parameter_max_length = 0` to prevent argument logging. |
| **6. Tracing Span Attributes (OpenTelemetry)** | Span attributes recording full request URL and query string | OpenTelemetry HTTP span processors configured to scrub query strings and sanitize URL attributes. |
| **7. Core Dumps & Heap Snapshots** | Memory dumps capturing in-flight vendor responses to disk | Disable container core dumps (`ulimit -c 0`) in production; strip heap snapshot data before profiling. |
| **8. Database Backups & Replicas** | Backups/replicas leaking unmanaged vendor records | Isolate `ride_vendor_data`; verify backups adhere to retention windows and replica permissions. |
| **9. Data Warehouse & BI Exports** | ETL tools (Fivetran/Airbyte/BigQuery) bypassing DB roles | Pipeline connectors must explicitly blacklist `ride_vendor_data` and `ride_receipts` from warehouse ingestion. |
| **10. Mobile Analytics & Crash SDKs** | Crashlytics/Mixpanel recording screen state or search inputs | App controllers strip search query text and vendor suggestions from analytics event dictionaries. |
| **11. Support-Desk Tools** | Zendesk/Freshdesk capturing raw billing receipts | Customer service interfaces display receipts via ephemeral rendering; export to CSV barred. |
| **12. CDN Logs (Cloudflare/CloudFront)** | Edge access logs persisting query parameters | CDN edge log distributions configured to strip query strings from all API logging streams. |
| **13. Redis Autocomplete Cache** | RDB snapshots or AOF logs writing cache to disk | Dedicated volatile Redis instance: `save ""` (RDB disabled), `appendonly no` (AOF disabled); managed-Redis automated snapshots and replicas disabled. |
| **14. Console Output (`console.log`)** | Accidental debugging dumps in production | ESLint rule `no-console: error` enforced in CI/CD pipeline. |
| **15. Network Dumps (HAR / pcap)** | Storing network traces during staging tests | Automated network tracing strictly prohibited in production environments. |

---

## 6. Cryptographic Provenance Architecture (`FieldProvenance`)

Every record published in `dpmaps.public_pois` carries an immutable, verifiable provenance record. Note that open-source OSM records reside exclusively in `dpmaps.osm_pois`, so `public_pois` records are **first-party by construction, subject to audit**:

```typescript
export interface FieldProvenance {
  version: number;                // Incremental version of this record
  record_id: string;              // Unique first-party POI or cluster identifier
  source_type: 'pin_tool' | 'merchant_onboarding' | 'post_trip_label' | 'trip_cluster';
  source_id?: string;             // Internal surveyor ID (linked to 001 backlog) or merchant ID
  lat: number;                    // WGS84 Latitude
  lng: number;                    // WGS84 Longitude
  display_name: string;           // Canonical English display name
  bangla_name: string;            // Canonical Bengali name
  category: string;               // 23-category taxonomy value
  point_type: string;             // 'building_entrance' | 'perimeter_gate' | 'curb_stop' | 'centroid'
  search_aliases: string[];       // Sorted array of validated search aliases
  parent_place_id?: string;       // Linked parent venue ID (or null)
  normalizer_version: string;     // e.g. "norm-v2.4.0"
  ruleset_version: string;        // e.g. "rule-2026.11"
  publication_cycle: string;      // e.g. "pub-2026-11-01"
  vote_count?: number;            // Total weighted votes in cluster
  unique_riders?: number;         // Count of distinct pseudonyms
  confidence_score: number;       // Wilson lower bound score (0.00 - 1.00)
  license_classification: 'first_party_proprietary';
  previous_cycle_hash?: string;   // SHA-256 hash of previous version (hash chain)
  canonical_payload_hash: string; // Unkeyed SHA-256 of canonical payload
  audit_hmac: string;             // Secret-keyed HMAC-SHA256 for internal tamper verification
}

export interface ProvenanceEvent {
  event_id: string;               // UUID v4
  event_type: 'publish' | 'takedown' | 'rollback' | 'deprecate';
  record_id: string;              // POI or cluster ID
  target_record_hash: string;     // canonical_payload_hash of affected record
  reason_code: string;            // e.g. "TAKEDOWN_PRIVACY_REQUEST", "DEFECT_ROLLBACK"
  publication_cycle: string;
  timestamp: string;              // ISO 8601
  actor_id: string;               // Operator ID executing action
  event_hash: string;             // SHA-256 of canonical event payload
}
```

### 6.1 Canonical Serialization & Merkle Tree Root
Aliases and names are where contaminated vendor strings are most prone to enter. To guarantee that any post-publication alias injection or renaming is cryptographically detected:
1. **Unkeyed Canonical Payload Hash:**
   $$\text{CanonicalString} = \text{LengthPrefixed}([ \text{record\_id}, \text{source\_type}, \text{source\_id}, \text{lat}, \text{lng}, \text{display\_name}, \text{bangla\_name}, \text{category}, \text{point\_type}, \text{CanonicalArray}(\text{search\_aliases}), \text{parent\_place\_id}, \text{version}, \text{vote\_count}, \text{confidence\_score}, \text{publication\_cycle}, \text{normalizer\_version}, \text{ruleset\_version}, \text{previous\_cycle\_hash} ])$$
   $$\text{canonical\_payload\_hash} = \text{SHA-256}(\text{CanonicalString})$$
   $$\text{audit\_hmac} = \text{HMAC-SHA256}(\text{SecretKmsKey}, \text{canonical\_payload\_hash})$$

   *Rationale:* An HMAC alone cannot be verified in court without revealing the secret key, compromising all records. Anchoring the unkeyed `canonical_payload_hash` allows independent public verification, while the HMAC provides an internal layer of tamper resistance.

2. **Merkle Tree Root Anchoring:**
   Rather than a flat hash list, the publication cycle builds a **Merkle Tree** over all `canonical_payload_hash` values in the release:
   $$\text{ManifestMerkleRoot} = \text{MerkleTreeRoot}(\{ \text{canonical\_payload\_hash}_1, \dots, \text{canonical\_payload\_hash}_N \})$$
   This enables proving the inclusion and exact provenance of a single POI record to auditors or legal authorities using an $O(\log N)$ Merkle audit path without disclosing or unmasking the rest of the database.
3. **Timestamp Anchoring:**
   The `ManifestMerkleRoot` is submitted to an RFC 3161 compliant Trusted Timestamping Authority (TSA), producing an immutable, non-repudiable timestamp receipt.
4. **Append-Only Event Ledger:**
   Removals, takedowns, and rollbacks are recorded as immutable `ProvenanceEvent` entries in the same ledger, ensuring historical continuity.
5. **Surveyor ID Linkage:**
   The `source_id` links directly to individual surveyor accounts, completing the Pin Tool contributor tracking backlog established in Stage 001.

---

## 7. Merchant Onboarding Clean-Room Requirements

Merchants onboarded via Ride Merchant Portal supply their physical business coordinates and storefront names directly:
- **Clean-Room Warranty:** Before submitting storefront details, the merchant must electronically execute the **Merchant Clean-Room Warranty**:
  > *"I warrant that these storefront coordinates and business names reflect my physical establishment or were placed using the provided OpenStreetMap tool. No data was copied from Google Maps, Barikoi, or competing platforms."*
- **Basemap Constraint:** The merchant onboarding pin tool renders exclusively OpenStreetMap raster tiles (no satellite imagery).

---

## 8. Automated CI/CD Canary-Value Fuzz Testing

Rather than testing for field names (which leaks values through unlisted keys), Stage 002 implements **Canary-Value Fuzzing** across all infrastructure sinks:

```
[ CI Test Runner ]
       │
       ▼
[ Generate High-Entropy Sentinel Values ]
• Strings: "CANARY_STR_9f83a1b", "CANARY_PLACE_88291a"
• Coords:  Lat 23.81234567, Lng 90.41234567
       │
       ▼
[ Inject Sentinels into Mock Vendor Payloads at Random Depths ]
(Inside error_message, query params, headers, bare arrays, polylines)
       │
       ▼
[ Execute Full Ride Dispatch & Autocomplete Integration Suite ]
       │
       ▼
[ Comprehensive Sink Inspection & Scoped Assertions ]
├── Positive Control 1: Client HTTP response (MUST contain sentinel suggestion)
├── Positive Control 2: ride_vendor_data (MUST contain sentinel destination coords)
├── Positive Control 3: ride_receipts (Controlled sink; must contain if enabled)
├── Scoped Redis Check: Sentinel allowed ONLY under autocomplete:vendor:* or
│   vendor:resolve:* with active TTL set; ZERO RDB/AOF files on disk.
├── Accelerated TTL Test: Advance clock past TTL -> Sentinel MUST BE GONE from Redis.
└── Firewall Assertion: ZERO sentinels across all other sinks:
    ├── PostgreSQL first-party tables (`orders`, all `dpmaps.*`)
    ├── MeiliSearch search indexes and dumps
    ├── Data warehouse / BI exports (ClickHouse, BigQuery)
    ├── Database replicas and backup dumps
    ├── Application log files (Winston/Pino)
    ├── Mock Sentry/APM captured payloads
    └── NGINX proxy access logs (host & status code only)
```

### 8.1 Scoped Assertions & Positive Controls
1. **Positive Controls:**
   - **Client HTTP Response:** Sentinel **must be present** in the client HTTP autocomplete response payload (where suggestion display text legitimately travels to the handset UI).
   - **`ride_vendor_data`:** Sentinel **must be present** in the isolated `ride_vendor_data` table for the simulated ride.
   - **`ride_receipts`:** If receipt storage holds vendor text pending tax counsel clearance, sentinel **must be present** in `ride_receipts` as a controlled sink; if receipts are first-party ADM3, sentinel must be zero.
   - **Redis In-Memory Cache:** Sentinel is permitted **only** under `autocomplete:vendor:*` and `vendor:resolve:*` keys and **must have an active TTL** set ($\le 24\text{h}$ or $\le 120\text{s}$).
2. **Persistence & Expiry Assertions:**
   - Scanner confirms that **no Redis RDB (`dump.rdb`) or AOF (`appendonly.aof`) files exist** on disk.
   - **Accelerated Expiry Test:** Advancing the test environment clock past the TTL must verify that the sentinel is **completely expunged** from Redis memory.
3. **Firewall Assertion:** The scanner asserts **zero occurrences** of the sentinel values across all other sinks: PostgreSQL `orders` and `dpmaps.*` tables, MeiliSearch indexes, data warehouse exports, database replicas, backup dumps, application logs, APM payloads, and proxy logs.

---

## 9. Contamination Incident Runbook & Data Handling Policy

### 9.1 Contamination Incident Runbook
If vendor-derived text or coordinates are detected in first-party assets:

1. **Detection Mechanisms:**
   - Automated canary scanning in CI/CD and scheduled publication jobs.
   - Anomaly detection flagging address strings containing vendor-specific formatting patterns.
   - Receipt of external third-party takedown requests or legal notices.
2. **Pre-Agreed Legal-Hold Protocol:**
   - Before executing a destructive purge, follow the protocol established with external legal counsel: determine whether a sealed, encrypted forensic archive (`contamination_forensic_hold_<timestamp>.tar.enc`) must be captured for evidentiary defense in court.
   - If required, this copy is encrypted with counsel's public key and deposited in an air-gapped cold storage vault accessible only by legal counsel.
3. **Quarantine:** Immediately freeze the publication pipeline, **pause all telemetry ingestion and evidence accumulation, and halt all background learning workers** (`evidenceDecayWorker`, `winnerSelectionWorker`, `aliasClusteringWorker`). Customer-facing dispatch remains on external vendor fallback with learning completely disabled.
4. **Audit & Trace:** Identify all records sharing the contaminated `publication_cycle` or contributor ID using the provenance ledger.
5. **Comprehensive Multi-Sink Purge:**
   Execute coordinated hard deletes across all 6 persistent layers:
   - **PostgreSQL:** Hard delete from `dpmaps.public_pois` and `dpmaps.evidence_ledger`.
   - **Database Backups:** Expunge or mark contaminated backup snapshots and WAL segments.
   - **Search Indexes:** Purge contaminated documents from MeiliSearch indexes and snapshots.
   - **Vector Tiles:** Regenerate affected PMTiles / MBTiles vector tiles immediately.
   - **Edge & Redis Caches:** Flush in-memory Redis caches and purge CDN edge tile distributions.
   - **Mobile Offline Bundles:** Increment the offline bundle version number, forcing mobile handsets to invalidate local caches and re-download clean bundles on next startup.
6. **Clean Rebuild:** Re-run the publication cycle using the continuous evidence ledger minus the quarantined records.
7. **Counsel Notification:** Submit a formal incident report to external legal counsel documenting the source, scope, purge verification, and mitigation.

### 9.2 Developer Vendor-Data Handling Policy
- Engineers are **strictly prohibited** from pasting real commercial vendor API responses into Jira tickets, Slack channels, email threads, or external AI prompt sessions.
- All development and staging tests must use synthetic mock payloads generated by local factories.

---

## 10. Legal Checklist & Counsel Packet

All legal assessments are subject to written confirmation by external Bangladeshi counsel. Stage 002 formalizes the review checklist and prepares a complete **Counsel Packet**:

### 10.1 Legal Review Matrix

| # | Legal Domain | Priority | Specific Question for External Counsel | Owner | Due | Status |
|---|---|:---:|---|:---:|:---:|:---:|
| **1** | **Data Protection Law Status** | P1 | What is the current formal legislative status and enforcement timetable of any enacted or pending Bangladesh data protection legislation? `[UNVERIFIED - confirm status with counsel]` | Counsel | Pre-Pilot | Pending Review |
| **2** | **Pseudonymization vs. Personal Data** | P1 | Under Bangladeshi law (with GDPR Art. 4(5) as a comparative benchmark), does HMAC-hashed telemetry with destroyed 90-day window keys qualify as anonymized data? | Counsel | Pre-Pilot | Pending Review |
| **3** | **Keystroke Telemetry Lawful Basis** | **P0** | Does capturing pre-autocomplete typed strings at the selection moment require explicit opt-in consent during onboarding under Bangladeshi law (do not assume "legitimate interest" exists)? | Counsel | **Pre-Shadow Gate** | Pending Review |
| **4** | **Account Deletion & Right to Erasure** | P1 | How does the platform demonstrate compliance with erasure requests when historical votes exist only as HMAC pseudonyms whose key is destroyed? | Counsel | Pre-Pilot | Pending Review |
| **5** | **Minors & School Telemetry** | P1 | What specific telemetry and location restrictions apply to passenger telemetry involving students under the age of 18 traveling to/from educational institutions? | Counsel | Pre-Pilot | Pending Review |
| **6** | **Cross-Border Cloud Hosting** | P2 | Does hosting OSRM graph containers and PMTiles on Singapore cloud infrastructure violate domestic data residency mandates? | Compliance | Pre-GA | Pending Review |
| **7** | **Vendor Contract Compliance** | **P0** | Does utilizing Barikoi-assisted trips (capturing rider typed characters and driver physical GPS dropoffs) violate Barikoi's ToS, given that **zero Barikoi output is stored**? | Counsel | **Pre-Shadow Gate** | Pending Review |
| **8** | **ODbL Derivative-Database Exposure** | P1 | Does maintaining OSM road geometry in `dpmaps.osm_pois` create any share-alike exposure for Ride's proprietary `dpmaps.public_pois` table when merged at query time? | Counsel | Pre-Pilot | **Pending Review** |
| **9** | **Barikoi Selection Learning Permission** | P2 | Seek Barikoi's formal written permission to store and analyze user-selected vendor suggestions for quality benchmarking (clarify that dpMaps operates self-sufficiently without this). | Business / Legal | Pre-GA | Pending Review |
| **10** | **Named Private Houses & Takedowns** | P1 | Under Bangladeshi law, does publishing names of residential buildings create defamation or privacy liabilities, and does the <4hr takedown policy provide sufficient defense? | Counsel | Pre-Pilot | Pending Review |
| **11** | **Contributor Warranty Enforceability** | P1 | Are the click-through Clean-Room Contributor Agreement and Merchant Warranty legally enforceable under the Bangladesh Contract Act 1872 and Copyright Act 2000? | Counsel | Pre-Pilot | Pending Review |
| **12** | **Post-Trip Prompt Consent** | P2 | Does prompting riders to name an unindexed drop-off point require specific data processing disclosures under consumer protection or digital commerce guidelines? | Counsel | Pre-Pilot | Pending Review |
| **13** | **OSM Attribution Adequacy** | P2 | Does the proposed client UI footer attribution (*"Map data & POIs © OpenStreetMap contributors under ODbL"*) satisfy Section 4.3 of the ODbL 1.0 license? | Counsel | Pre-Pilot | Pending Review |
| **14** | **Vendor Order Data Retention** | **P0** | What is the legally permissible retention period for vendor-derived transactional data (quoted distance, billed coordinates) in order/receipt records post-termination? | Counsel | **Pre-Shadow Gate** | Pending Review |
| **15** | **Vendor Contract Termination Clauses** | **P0** | Review Barikoi contract clauses regarding derived data, competing database restrictions, reverse engineering prohibitions, and post-termination survival. | Counsel | **Pre-Shadow Gate** | Pending Review |
| **16** | **Vendor Caching Rights (24h Redis & Client Caches)** | **P0** | Does caching vendor autocomplete suggestions for up to 24 hours in Redis and ephemeral client-side caches violate Google Maps or Barikoi contractual terms restricting caching or storing of map data? | Counsel | **Pre-Shadow Gate** | Pending Review |
| **17** | **Driver GPS Consent & Vehicle Telemetry** | **P0** | Are drivers' onboarding agreements and independent contractor terms sufficient under Bangladeshi law to grant Ride explicit consent to record GPS telemetry and derive traffic speed models and dropoff clusters? | Counsel / Ops | **Pre-Shadow Gate** | Pending Review |

> [!CAUTION]
> ### MANDATORY LEGAL GATE: PHASE 1 START REQUIRES LEGAL RESOLUTION
> Phase 1 operations (including OSRM shadow benchmarking in Plans 004 and 005, which ingest driver GPS and compare against vendor quotes) cannot commence until **Items 3, 7, 14, 15, 16, and 17** are formally reviewed, resolved, and signed off in writing by external Bangladeshi legal counsel. Legal counsel engagements must be scheduled and completed during Phase 0 as a hard prerequisite for Phase 1 start.

### 10.2 The Counsel Packet Checklist
The engineering team will formally assemble and submit the following documents to legal counsel:
- [ ] 1. Current commercial Barikoi & Google contracts, rate sheets, and amendments.
- [ ] 2. The dpMaps System Architecture Summary.
- [ ] 3. End-to-End Data Flow Diagram (showing memory isolation and transactional separation).
- [ ] 4. The 4-Tier Geospatial Data Retention Policy Table (§11.1).
- [ ] 5. Clean-Room Contributor Agreement and Merchant Onboarding Warranty text.
- [ ] 6. Location Takedown & Privacy Policy.

---

## 11. Deliverables & Definition of Done

- [ ] `utils-server/vendorClientWrapper.ts` implemented; all raw vendor responses encapsulated in private function scope.
- [ ] `fetchSafeVendorSuggestions(query, userLoc)` implemented; ephemerally stores destination coordinates under `vendor:resolve:*` (120s TTL) and emits coordinates-withheld DTOs.
- [ ] `resolveVendorSelection(temp_client_id)` implemented using atomic Redis `GETDEL`; returns coordinates strictly to the dispatch module, failing safely on null without storage fallback.
- [ ] `SafeVendorSuggestion` display text and `SafeVendorRouteResult` polyline verified as response-only: never logged, stored in databases, or forwarded to telemetry.
- [ ] Vendor data physically isolated in `ride_vendor_data`; `dpmaps_worker` granted explicit column-level permissions strictly on first-party `orders` columns (`elapsed_seconds`), with `REVOKE ALL` on `ride_vendor_data` and `ride_receipts`.
- [ ] Auxiliary sinks configured: Sentry `beforeBreadcrumb`/`beforeSend` scrubbers active, proxy logging for outbound vendor calls records host & status only, Postgres `log_parameter_max_length = 0` set, and managed Redis automated snapshots/replicas disabled.
- [ ] OpenTelemetry span processors, heap profiling, ETL blacklists, mobile crash SDKs, support receipt views, and CDN log query-stripping verified.
- [ ] Canonical serialization covering `record_id`, `bangla_name`, `category`, `point_type`, `search_aliases`, and `parent_place_id`, unkeyed payload hash, HMAC, and Merkle tree root anchoring implemented for `FieldProvenance`; append-only event ledger active for takedowns and rollbacks.
- [ ] `source_id` linked to per-surveyor IDs from the Stage 001 Pin Tool upgrade backlog.
- [ ] Scoped CI canary-value fuzz test runner active: verifies positive controls in client HTTP response, `ride_vendor_data`, and `ride_receipts`; verifies scoped Redis keys with TTL and zero RDB/AOF files; confirms complete expungement after accelerated TTL; asserts zero sentinel occurrences across warehouse, replicas, backups, logs, and search indexes.
- [ ] Mobile client search controller captures query buffer only at selection moment (Bengali digits normalized, spaces/hyphens/dots stripped, runs of 9+ digits discarded, max 80 chars, autofill isolated).
- [ ] Multi-sink contamination incident runbook (quarantine pausing ingestion and learning) and pre-agreed counsel forensic-hold protocol published in engineering handbook.
- [ ] Complete Counsel Packet submitted; **Mandatory Legal Gate enforced: Phase 1 start blocked until Items 3, 7, 14, 15, 16, and 17 are resolved**.
