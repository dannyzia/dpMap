# Stage 006: Vector Tiles, PMTiles & Bengali Glyphs Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-006 (Revision 2.1 — Clean-Room Cartography, Sized PMTiles Pipeline & Purge-Tagged R2 Delivery)
**Stage:** 6 of 16 (Cartography & Edge Asset Delivery)
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§17.2–17.3, §19 Phase 3, §20–21)
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)
**Current Status:** **NotDone**

---

## 1. Executive Summary & Objective

Rendering interactive maps on passenger and driver mobile handsets without third-party SDK fees (commercial mapping SDKs bill per load `[UNVERIFIED — vendor pricing not established in this repository]`) requires an autonomous, self-hosted vector cartography stack. Two failure modes dominate in Bangladesh:
1. **Bengali Glyph Corruption ("Tofu Boxes"):** Western font stacks fail to render the Bengali Unicode block (`U+0980`–`U+09FF`), showing blank boxes or mangling matras and conjuncts (*yuktakshors* like ক্ষ, জ্ঞ).
2. **Bandwidth & Egress Costs:** Panning dynamic tiles across millions of daily rides incurs cloud egress fees and sluggish rendering on 3G/4G networks.

Stage 006 implements an autonomous cartographic pipeline in two milestones:
- **Phase 0 (Pre-Launch):** pre-generate *Noto Sans Bengali* (Regular/Bold) SDF glyph ranges and category sprites on Cloudflare R2 — fixes Bengali rendering from Day 1.
- **Phase 3 (Autonomous Cartography):** compile `bangladesh.pmtiles` (Z0–Z14, ~350–390 MB `[ESTIMATE]`) via Planetiler from the verified 339 MB Geofabrik extract `[VERIFIED size, concept paper §21]`, serve via R2 + CDN with byte-range caching and purge tagging, and switch MapLibre clients to sovereign endpoints.

**Clean-room boundary (Invariant 4):** the PMTiles archive is an **OSM derivative** (ODbL). First-party `dpmaps.public_pois` are served by a physically separate overlay (§8.2) and never merged into OSM derivative files. Nothing vendor-derived (Barikoi/Google) enters tiles, glyphs, or sprites (Hard Rule 1).

> [!CAUTION]
> ### MANDATORY LEGAL / POLICY PREREQUISITES
> 1. **Hard Rule 7 (Raster Imagery):** mobile client and Pin Tool use **OpenStreetMap raster tiles only**. Zero Google, Bing, Esri, or Barikoi imagery in any environment (§2).
> 2. **ODbL Attribution (Legal Item 13):** the client footer attribution string (§8.3) is implemented at first render; its adequacy under ODbL §4.3 is **counsel review Item 13 `[UNVERIFIED]`** — do not claim compliance.

---

## 2. Clean-Room Cartography & Raster Imagery Policy (F-006-1)

> [!IMPORTANT]
> **Hard Rule 7 — enforced here, tested in CI:**
> - **Pin Tool (Stage 001/008 field tool):** Leaflet base layer = OpenStreetMap raster tiles (`tile.openstreetmap.org` or self-hosted raster) **only**. No Esri World Imagery, no Bing, no Google satellite, no Barikoi tiles — in any build flavor.
> - **Mobile client:** MapLibre styles reference only `tiles.ride.com` (PMTiles + glyphs + sprites) and the first-party overlay (§8.2). Raster fallback layers, if any, are OSM raster only.
> - **Operational Mandate:** OSMF's tile usage policy explicitly discourages field tools and intensive surveyor panning against `tile.openstreetmap.org`. To eliminate IP blocking risk and preserve clean-room independence, dpMaps deploys a self-hosted raster tile server (`tileserver-gl` or rasterized local PMTiles) for the Phase 0 Pin Tool campaign from Day 0.
> - **Noto fonts are build-time inputs** (SIL Open Font License, fetched from the `googlefonts/noto-fonts` mirror). Fonts are not map data; at **runtime** the client loads zero Google endpoints (glyph PBFs are self-hosted, §3).

---

## 3. Phase 0: Bengali Font Glyph Generation (*Noto Sans Bengali*)

MapLibre renders text with SDF glyph PBFs partitioned into 256-codepoint ranges (`{fontstack}/{start}-{end}.pbf`).

```
[ Noto Sans Bengali TTF ] + [ Noto Sans Latin TTF ]
                       │
                       ▼
     [ node-fontnik / glyph-pbf-composite ]
                       │
          ┌────────────┴────────────┐
          ▼                          ▼
   [ Range 0-255.pbf ]      [ Range 2304-2559.pbf ]
   • Basic Latin / ASCII    • Bengali Unicode (U+0900–U+09FF)
   • Numerals, punctuation  • Consonants, vowels, matras
   • Road abbreviations     • Digits ০–৯ (U+09E6–U+09EF), ৳ (U+09F3)
```

### 3.1 Glyph Range Conformance (F-006-4)
- Full Bengali block `U+0980`–`U+09FF` maps to range **`2304-2559.pbf`** ($2304 = \text{0x0900}$, $2559 = \text{0x09FF}$): vowels/consonants (U+0985–U+09B9), matras (U+09BE–U+09CC), virama/halant ঍ (U+09CD) for conjuncts, digits ০–৯ (U+09E6–U+09EF), taka ৳ (U+09F3).
- **Every fontstack named in `style.json` must have generated PBFs.** The build produces the composite stacks `Noto Sans Bengali Regular` and `Noto Sans Bengali Bold` (Bengali + Latin merged); the style references **only these stacks** (or the build additionally emits `Noto Sans Regular`/`Noto Sans Bold` stacks — both options are acceptable; mismatched references are a build failure).
- Fontstack path segments contain spaces: the glyph URL template must serve URL-encoded names (`Noto%20Sans%20Bengali%20Regular`); MapLibre encodes automatically — the R2 worker must not double-encode.
- **Validation steps (Tofu vs. Complex Shaping):**
  1. *Glyph Coverage (Headless):* Render test string *"ক্ষ জ্ঞ ০-৯ ৳ ধানমন্ডি"* headlessly and assert zero tofu boxes `[ESTIMATE tooling]`.
  2. *Device-Level Text Shaping Test (Phase 0 Gate):* Tofu tests glyph availability, not complex Indic shaping. Render the test string on Android and iOS `maplibre-native` (and `maplibre-gl-js`) side-by-side against a native platform-shaped reference (e.g. Android `TextView`). Assert correct conjunct formation (e.g., ক্ষ formed cleanly, not decomposed as ক + ্ + ষ) and matra reordering. If shaping decomposes, activate fallback hierarchy: pre-shaped font ligatures, platform-native symbol layer for first-party places, or low-zoom Latin prioritization.

### 3.2 Automated Glyph Build (`scripts/generate-glyphs.sh`)
```bash
#!/usr/bin/env bash
# scripts/generate-glyphs.sh
set -eo pipefail

BUILD_DIR="/opt/dpmaps/fonts/build"
OUTPUT_DIR="/opt/dpmaps/cartography/glyphs"

mkdir -p "${BUILD_DIR}" && cd "${BUILD_DIR}"

echo "=== [Step 1/3] Downloading Noto Sans Bengali & Latin (SIL OFL) ==="
wget -q -nc https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSansBengali/NotoSansBengali-Regular.ttf
wget -q -nc https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSansBengali/NotoSansBengali-Bold.ttf
wget -q -nc https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf
wget -q -nc https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Bold.ttf

echo "=== [Step 2/3] Generating Composite SDF Glyph Ranges ==="
build_fontstack() {
  local STACK_NAME="$1" BENGALI_TTF="$2" LATIN_TTF="$3"
  local TARGET="${OUTPUT_DIR}/${STACK_NAME}"
  mkdir -p "${TARGET}"
  npx @mapbox/glyph-pbf-composite "${BENGALI_TTF}" "${LATIN_TTF}" "${TARGET}"
}
build_fontstack "Noto Sans Bengali Regular" "NotoSansBengali-Regular.ttf" "NotoSans-Regular.ttf"
build_fontstack "Noto Sans Bengali Bold"    "NotoSansBengali-Bold.ttf"    "NotoSans-Bold.ttf"

echo "=== [Step 3/3] Validating ranges 0-255.pbf & 2304-2559.pbf ==="
for STACK in "Noto Sans Bengali Regular" "Noto Sans Bengali Bold"; do
  test -s "${OUTPUT_DIR}/${STACK}/0-255.pbf" && test -s "${OUTPUT_DIR}/${STACK}/2304-2559.pbf"
done
echo "Glyph generation completed."
```

---

## 4. Phase 0: Sprites & Category Iconography

SVG icons (32×32) compile to sprite sheets (`sprite.png`/`sprite.json`, `sprite@2x.*`) via `spritetext`/`spritezero-cli` `[UNVERIFIED tooling — consider the maintained 'sreet' alternative]`. Icons cover mosque, MRT station, CNG stand, bus terminal, hospital, pharmacy, school, bazaar **plus badge icons for the Stage 008 provenance badges: `verified_landmark` (green check) and `open_directory` (neutral ODbL mark)** so map and search UI share one iconography source. Hosted at `https://tiles.ride.com/sprites/sprite`.

---

## 5. Phase 3: Planetiler National PMTiles Compilation (F-006-2 sizing model)

PMTiles is a single-file tile archive queried directly over HTTP **Range Requests** (`Range: bytes=start-end`) — no tile server, no loose files.

### 5.1 Sizing & Resource Model (all figures `[ESTIMATE]` unless marked)

| Resource | Build instance | Notes |
|---|---|---|
| Input | `bangladesh-latest.osm.pbf` ≈ 339 MB | `[VERIFIED — concept paper §21]` |
| JVM heap | `-Xmx8g` (G1GC) | tune to `-Xmx12g` if build OOMs `[ESTIMATE]` |
| Instance RAM / vCPU | 16 GB / 8 vCPU | `[ESTIMATE]`; AGENTS.md §10: RAM/throughput on real data **UNVERIFIED** |
| Scratch disk | ≥ 60 GB free (mmap + intermediate) | `[ESTIMATE]` |
| Build runtime | 12–18 min on the above instance | `[ESTIMATE — measure; AGENTS.md §10 UNVERIFIED]` |
| Output `bangladesh.pmtiles` | ~350–390 MB (Z0–Z14) | `[ESTIMATE — TOC Phase 3 cites ~390 MB; measure]` |
| Offline `dhaka_core_z11.pmtiles` | ~45 MB (Z0–Z11) | `[ESTIMATE — measure]` |

### 5.2 Compilation Script (`scripts/build-pmtiles.sh`)
```bash
#!/usr/bin/env bash
set -eo pipefail

DATA_DIR="/opt/dpmaps/data"
OUTPUT_DIR="/opt/dpmaps/cartography"
PLANETILER_JAR="/opt/dpmaps/tools/planetiler.jar"
BBOX="88.01,20.57,92.68,26.63"   # approximate Bangladesh bounds [approximate]

mkdir -p "${OUTPUT_DIR}" "/opt/dpmaps/tools"

if [ ! -f "${PLANETILER_JAR}" ]; then
  curl -sSL "https://github.com/onthegomap/planetiler/releases/download/v0.8.2/planetiler.jar" -o "${PLANETILER_JAR}"  # version [UNVERIFIED — pin after CI bake]
fi

java -Xmx8g -XX:+UseG1GC -jar "${PLANETILER_JAR}" \
  --osm-path="${DATA_DIR}/bangladesh-latest.osm.pbf" \
  --output="${OUTPUT_DIR}/bangladesh.pmtiles" \
  --bounds="${BBOX}" \
  --max-zoom=14 --min-zoom=0 \
  --nodemap-type=sparsearray --storage=mmap \
  --download=false

npx pmtiles show "${OUTPUT_DIR}/bangladesh.pmtiles"
ls -lh "${OUTPUT_DIR}/bangladesh.pmtiles"
```

Archive notes: OpenMapTiles-compatible schema; Z14 includes building footprints, residential lanes, water bodies. The archive is an **ODbL derivative** — tagged and attributed as such (§8.3); first-party POIs are NOT in it (§8.2).

---

## 6. Cloudflare R2 Edge Storage & Cache Configuration (F-006-3)

```
                [ Mobile Client / Pin Tool ]
                          │  GET Range: bytes=1048576-1052672
                          ▼
            [ Cloudflare Edge CDN (DAC / SIN PoP) ]
                │ cache hit                │ miss
                ▼                          ▼
          [ Edge Cache ]        [ R2 bucket: dpmaps-tiles ]
                                ├── bangladesh.pmtiles        (ODbL derivative)
                                ├── first_party.pmtiles       (first-party overlay, §8.2)
                                ├── glyphs/Noto Sans Bengali …/
                                └── sprites/sprite*
```

1. **Bucket:** `dpmaps-tiles` (R2, S3-compatible, zero egress fees `[ESTIMATE — verify current R2 pricing terms]`), public access **only** via the Cloudflare worker/CDN hostname `tiles.ride.com` (bucket itself stays private; worker serves objects).
2. **Byte-range caching:** PMTiles clients issue `Range` requests; Cloudflare caches sub-slices at edge PoPs. Cache rules:
   - `bangladesh.pmtiles`, `first_party.pmtiles`: Cache Everything, `public, max-age=2592000, immutable` **for versioned object names** (see purge strategy below).
   - `glyphs/*`: `public, max-age=31536000, immutable`.
   - `sprites/*`: `public, max-age=86400`.
3. **Cache purge & Versioned Overlay Strategy (emergency suppression integration — Stage 011 §5.2 Tier D):**
   - **Primary Default Posture (No Cloudflare Enterprise Dependency):** The proprietary overlay is published under versioned names (`first_party-<sha>.pmtiles`), while `first_party.pmtiles` acts as a short-TTL pointer (`Cache-Control: public, max-age=60`). Upon suppression, the tiny overlay is rebuilt (<60 s) and re-pointed. Paired with immediate client-side MapLibre feature ID filtering (`['!=', ['get', 'id'], suppressed_id]`), this satisfies the <1h SLA unconditionally without requiring Cloudflare Enterprise tag purging.
   - **Enterprise Optimization (Optional):** If an Enterprise plan is active, responses carry `Cache-Tag: fp-poi` and purges trigger `POST /purge_cache` with tag `fp-poi` with budget `< 30 s` `[ESTIMATE]`.
   - Whole-archive rebuilds for the large OSM base publish **versioned names** (`bangladesh-<buildhash>.pmtiles`) and atomically re-point `bangladesh.pmtiles` — immutable caching remains strictly on versioned files.
4. **CORS:** allow `GET, HEAD` with `Range, If-None-Match` headers; expose `Content-Range, Content-Length, ETag`; origins limited to Ride app schemes + `localhost` dev hosts.

---

## 7. Bilingual MapLibre Style (`style.json`) — corrected fontstacks

```json
{
  "version": 8,
  "name": "dpMaps Sovereign Light",
  "sources": {
    "openmaptiles": {
      "type": "vector",
      "url": "pmtiles://https://tiles.ride.com/bangladesh.pmtiles"
    },
    "first_party": {
      "type": "vector",
      "url": "pmtiles://https://tiles.ride.com/first_party.pmtiles"
    }
  },
  "glyphs": "https://tiles.ride.com/glyphs/{fontstack}/{range}.pbf",
  "sprite": "https://tiles.ride.com/sprites/sprite",
  "layers": [
    { "id": "background", "type": "background", "paint": { "background-color": "#f8f9fa" } },
    { "id": "water", "type": "fill", "source": "openmaptiles", "source-layer": "water",
      "paint": { "fill-color": "#cce5ff" } },
    { "id": "road_primary", "type": "line", "source": "openmaptiles", "source-layer": "transportation",
      "filter": ["in", "class", "primary", "secondary", "trunk"],
      "paint": { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 6] } },
    { "id": "place_label_bilingual", "type": "symbol", "source": "openmaptiles", "source-layer": "place",
      "layout": {
        "text-field": ["case",
          ["all", ["has", "name:bn"], ["has", "name:en"], ["!=", ["get", "name:bn"], ["get", "name:en"]]],
          ["concat", ["get", "name:bn"], "\n", ["get", "name:en"]],
          ["coalesce", ["get", "name:bn"], ["get", "name"], ["get", "name:en"], ""]],
        "text-font": ["Noto Sans Bengali Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 8, 11, 14, 15],
        "text-line-height": 1.2, "text-max-width": 9
      },
      "paint": { "text-color": "#1f2937", "text-halo-color": "#ffffff", "text-halo-width": 1.5 } },
    { "id": "poi_osm_open", "type": "symbol", "source": "openmaptiles", "source-layer": "poi",
      "layout": {
        "icon-image": ["concat", ["get", "class"], "_icon"],
        "icon-size": 0.8,
        "text-field": ["coalesce", ["get", "name:bn"], ["get", "name"]],
        "text-font": ["Noto Sans Bengali Regular"],
        "text-offset": [0, 1.2], "text-size": 11
      },
      "paint": { "text-color": "#374151", "text-halo-color": "#ffffff", "text-halo-width": 1.2 } },
    { "id": "poi_first_party_verified", "type": "symbol", "source": "first_party", "source-layer": "pois",
      "layout": {
        "icon-image": "verified_landmark_icon",
        "icon-size": 0.9,
        "text-field": ["coalesce", ["get", "bangla_name"], ["get", "canonical_name"]],
        "text-font": ["Noto Sans Bengali Regular"],
        "text-offset": [0, 1.2], "text-size": 11
      },
      "paint": { "text-color": "#14532d", "text-halo-color": "#ffffff", "text-halo-width": 1.2 } }
  ]
}
```

Notes: `text-font` lists **only generated stacks** (F-006-4). OSM `poi` layer stays unbadged (Stage 001 §6.3); first-party POIs render from the separate overlay with the verified icon.

---

## 8. First-Party Overlay, Attribution & Mobile Integration

### 8.1 Mobile PMTiles Protocol (corrected API — F-006-7)
```typescript
// mobile/src/map/pmtilesProtocol.ts
import { Protocol } from 'pmtiles';
import MapLibreGL from '@maplibre/maplibre-react-native';

export function initializeMapLibrePMTiles(): void {
  const protocol = new Protocol();
  MapLibreGL.addProtocol('pmtiles', protocol.tile); // NOT addCustomHeader (F-006-7 fix)
}
```

### 8.2 First-Party POI Overlay (F-006-5, Invariant 4)
- `first_party.pmtiles` is generated **nightly** from `dpmaps.v_search_feed_first_party` (Stage 003 Rev 2.4) by a dedicated build job: view → GeoJSON export → **tippecanoe** (`--drop-densest-as-needed`, z11–z16 `[ESTIMATE zooms]`) → `pmtiles convert` → versioned upload (`first_party-<buildhash>.pmtiles`, pointer swap as in §6.3). Tooling pinned in CI `[UNVERIFIED — pin tippecanoe/pmtiles versions after bake]`. Fallback if tippecanoe is undesirable: a runtime GeoJSON source from the search API (acceptable at ~2k POIs, heavier on mobile).
- The overlay is a **first-party asset** and is **never** merged into `bangladesh.pmtiles` or any OSM derivative (TOC Invariant 4).
- OSM `poi` features remain inside the ODbL archive. Badges: first-party = `verified_landmark_icon`; OSM = unbadged + attribution (Stage 008 parity).
- Suppression (Stage 011) removes POIs at the next overlay rebuild or immediately via `fp-poi` cache purge (§6.3) plus client-side filter of suppressed IDs served by the search API.

### 8.3 ODbL Attribution (F-006-6)
Whenever OSM-derived tiles or `osm_pois` render, the client footer shows:
> *"Map data & POIs © OpenStreetMap contributors under ODbL."* (Stage 001 §6.3)

Adequacy of this string under ODbL §4.3 is **Legal Item 13 `[UNVERIFIED]`** pending counsel; the element ships at first render regardless.

### 8.4 Offline Bundling
`dhaka_core_z11.pmtiles` (~45 MB `[ESTIMATE]`) bundles in app assets (`pmtiles://file:///android_asset/…`); online clients fetch Z12–Z14 from `tiles.ride.com`. Test: instant render with zero network.

---

## 9. Deliverables & Definition of Done

- [ ] **Hard Rule 7 enforcement test:** CI greps Pin Tool and mobile build configs for Esri/Bing/Google/Barikoi imagery endpoints — must be zero (F-006-1).
- [ ] Self-hosted raster tileserver deployed for Pin Tool field survey from Day 0, eliminating OSMF tile abuse risk.
- [ ] Glyphs: both composite stacks generate `0-255.pbf` + `2304-2559.pbf`; tofu-free headless test AND device-level complex Indic text shaping test on MapLibre Native vs platform TextView (ক্ষ, জ্ঞ, ০-৯, ৳, ধানমন্ডি) (F-006-4).
- [ ] Every `text-font` stack in `style.json` resolves against generated glyph PBFs (automated URL check).
- [ ] Sprites incl. `verified_landmark`/`open_directory` badges published (§4).
- [ ] Planetiler pipeline runs on the 339 MB extract; measured heap/runtime/output recorded in §5.1 (replacing `[ESTIMATE]`) (F-006-2).
- [ ] R2 bucket + CDN rules + CORS deployed; **Tier D emergency suppression verified via versioned overlay pointer (max-age=60) + client-side MapLibre feature filter** (no Cloudflare Enterprise dependency; optional purge-tag optimization) (F-006-3).
- [ ] `first_party.pmtiles` overlay serving verified badges from `v_search_feed_first_party`, physically separate from OSM archive (F-006-5).
- [ ] Attribution footer rendered wherever OSM data displays; Legal Item 13 routed to counsel (F-006-6).
- [ ] Mobile MapLibre integration on Android/iOS with corrected `addProtocol` registration; offline 45 MB bundle renders with zero network.

---

## 10. Revision Changelog

| Revision | Date | Author / Context | Summary of Major Changes |
|---|---|---|---|
| Rev 2.0 | 2026-10-22 | Orchestrator (audited baseline) | Glyph/sprite pipeline, Planetiler script, R2/CDN rules, bilingual style, offline bundle. |
| Rev 2.1 | 2026-10-22 | Lead Planning & Systems Architecture (batch-3 audit) | **Clean-Room Cartography, Sizing & Purge Pipeline:**<br>1. **Hard Rule 7 section (F-006-1):** OSM raster-only policy for Pin Tool & mobile; CI enforcement test; OSM tile-usage caveat; build-time font provenance vs zero runtime Google endpoints.<br>2. **Sizing model (F-006-2):** labeled heap/RAM/disk/runtime/output table; `[ESTIMATE]`/`[UNVERIFIED]` per AGENTS.md §10.<br>3. **R2 & purge tags (F-006-3):** bucket behind worker hostname, versioned archive names, `Cache-Tag`/Purge-by-Tag pipeline wired to Stage 011 Tier D; absolute claims softened.<br>4. **Glyph conformance (F-006-4):** style references only generated fontstacks; URL-encoding note; tofu render test.<br>5. **First-party overlay (F-006-5):** `first_party.pmtiles` + badge icons, physically separate from OSM derivatives (Invariant 4).<br>6. **ODbL attribution (F-006-6):** Stage 001 §6.3 footer string + Legal Item 13 caveat.<br>7. **Integrity (F-006-7):** invented SDK pricing removed; `addProtocol` fix; tooling `[UNVERIFIED]` notes. |
