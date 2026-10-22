# Stage 006: Vector Tiles, PMTiles & Bengali Glyphs Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-006 (Revision 2.0 — Vector Tiles, PMTiles & Bengali Glyphs)  
**Stage:** 6 of 16 (Cartography & Edge Asset Delivery)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§17.2–17.3, §19 Phase 3, §20)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **NotDone**  

---

## 1. Executive Summary & Objective

Rendering interactive maps on passenger and driver mobile handsets without paying exorbitant third-party SDK fees (Mapbox, Google Maps APIs costing $0.50–$2.00 per 1,000 loads) requires an autonomous, self-hosted vector cartography stack. In emerging mobile markets like Bangladesh, generic Western vector tile services suffer from two critical failures:
1. **Bengali Glyph Corruption ("Tofu Boxes"):** Standard Western font stacks fail to render the Bengali Unicode block (`\u0980` to `\u09FF`), displaying place names as blank rectangular boxes (`□`) or mangling composite vowel signs (*matras* and *yuktakshors* like ক্ষ, জ্ঞ, ঙ্ক).
2. **Bandwidth & Egress Costs:** Panning and zooming raster or dynamic vector tiles across millions of daily rides incurs crippling cloud egress fees and causes sluggish rendering on 3G/4G cellular networks.

Stage 006 implements an autonomous, zero-egress cartographic pipeline structured across two chronological milestones:
- **Phase 0 Execution (Pre-Launch):** Pre-generates *Noto Sans Bengali* (Regular and Bold) Signed Distance Field (SDF) glyph ranges and category sprites, hosted on Cloudflare R2 to fix Bengali rendering in mobile apps from Day 1.
- **Phase 3 Execution (Autonomous Cartography):** Compiles a single national archive (`bangladesh.pmtiles`, zoom 0–14, ~370 MB) via Planetiler, hosted on Cloudflare R2 with global edge caching and served directly to MapLibre GL mobile clients via HTTP byte-range requests.

---

## 2. Chronological Execution Roadmap

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        STAGE 006 PHASED EXECUTION ROADMAP                              │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ PHASE 0: PRE-LAUNCH GLYPHS & SPRITES (Month 0 / Pre-Launch)                            │
│ • Generate Noto Sans Bengali SDF glyphs: Regular & Bold (0-255.pbf and 2304-2559.pbf)  │
│ • Compile custom Dhaka vector sprites (1x & 2x): Mosque, MRT, CNG, Bus, Hospital       │
│ • Deploy to Cloudflare R2: https://tiles.ride.com/glyphs/ and /sprites/                │
│ • Fixes Bengali script rendering across mobile UI basemaps immediately                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ PHASE 3: AUTONOMOUS PMTILES CARTOGRAPHY (Months 5–6)                                   │
│ • Compile national bangladesh.pmtiles via Planetiler v0.8+ from Geofabrik extract      │
│ • Target size: ~350–390 MB covering Zoom 0 to 14 across all 64 districts               │
│ • Configure Cloudflare R2 bucket & CDN edge range-request caching (0ms origin latency) │
│ • Deploy MapLibre bilingual vector style (style.json) with Bengali primary hierarchy   │
│ • Bundle compact ~45 MB offline Dhaka basemap (Z0–Z11) in mobile client APK/IPA        │
│ • Cut over mobile clients from commercial basemaps to sovereign tiles.ride.com         │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Phase 0: Bengali Font Glyph Generation (*Noto Sans Bengali*)

MapLibre GL renders text on the GPU using Signed Distance Field (SDF) glyph protocol buffers partitioned into 256-codepoint chunks (`{fontstack}/{start}-{end}.pbf`).

```
[ Noto Sans Bengali TTF ] + [ Noto Sans Latin TTF ]
                       │
                       ▼
    [ node-fontnik / glyph-pbf-composite ]
                       │
         ┌─────────────┴─────────────┐
         ▼                           ▼
   [ Range 0-255.pbf ]     [ Range 2304-2559.pbf ]
   • Basic Latin / ASCII   • Bengali Unicode (0x0900–0x09FF)
   • Numerals, punctuation • Consonants, Vowels, Matras
   • Road abbreviations    • Bengali Digits: ০, ১, ২, ..., ৯
                           • Currency sign: ৳ (U+09F3)
```

### 3.1 Key Bengali Codepoints Verified
The glyph generator strictly verifies inclusion of the full Bengali Unicode block (`U+0980` to `U+09FF`), mapping into chunk **`2304-2559.pbf`** ($2304 = \text{0x0900}$, $2559 = \text{0x09FF}$):
- **Vowels & Consonants:** অ–ঔ (`U+0985`–`U+0994`), ক–হ (`U+0995`–`U+09B9`).
- **Dependent Vowel Signs (Matras):** া, ি, ী, ু, ূ, ৃ, ে, ৈ, ো, ৌ (`U+09BE`–`U+09CC`).
- **Virama / Halant:** ্ (`U+09CD`), mandatory for composite conjuncts (*yuktakshors* like ক্ষ, ষ্ণ, ঙ্গ, জ্ঞ).
- **Bengali Numerals:** ০, ১, ২, ৩, ৪, ৫, ৬, ৭, ৮, ৯ (`U+09E6`–`U+09EF`, decimal 2534–2543).
- **Taka Currency Symbol:** ৳ (`U+09F3`, decimal 2547).

### 3.2 Automated Glyph Build Script (`scripts/generate-glyphs.sh`)
```bash
#!/usr/bin/env bash
# scripts/generate-glyphs.sh
set -eo pipefail

BUILD_DIR="/opt/dpmaps/fonts/build"
OUTPUT_DIR="/opt/dpmaps/cartography/glyphs"

mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

echo "=== [Step 1/3] Downloading Google Noto Sans Bengali & Latin Fonts ==="
wget -q -nc https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSansBengali/NotoSansBengali-Regular.ttf
wget -q -nc https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSansBengali/NotoSansBengali-Bold.ttf
wget -q -nc https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf
wget -q -nc https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Bold.ttf

echo "=== [Step 2/3] Generating Composite SDF Glyph Ranges ==="

# Function to generate composite glyph ranges (Bengali + Latin fallback)
build_fontstack() {
  local STACK_NAME="$1"
  local BENGALI_TTF="$2"
  local LATIN_TTF="$3"
  local TARGET="${OUTPUT_DIR}/${STACK_NAME}"
  
  mkdir -p "${TARGET}"
  echo "Building fontstack: ${STACK_NAME}..."
  
  # Composite glyph ranges 0-255 (Latin) and 2304-2559 (Bengali)
  npx @mapbox/glyph-pbf-composite \
    "${BENGALI_TTF}" "${LATIN_TTF}" \
    "${TARGET}"
}

build_fontstack "Noto Sans Bengali Regular" "NotoSansBengali-Regular.ttf" "NotoSans-Regular.ttf"
build_fontstack "Noto Sans Bengali Bold" "NotoSansBengali-Bold.ttf" "NotoSans-Bold.ttf"

echo "=== [Step 3/3] Validating Bengali Glyph Range 2304-2559.pbf ==="
ls -lh "${OUTPUT_DIR}/Noto Sans Bengali Regular/2304-2559.pbf"
ls -lh "${OUTPUT_DIR}/Noto Sans Bengali Bold/2304-2559.pbf"

echo "Glyph generation completed successfully."
```

---

## 4. Phase 0: Vector Sprites & Category Iconography

To render custom POI badges and transit stops cleanly on high-DPI screens, vector sprites are compiled from SVGs into combined PNG sheets with metadata JSON:

```
[ Vector SVG Icons (32x32) ]
├── mosque.svg          (গম্বুজ আইকন)
├── mrt_station.svg     (Dhaka Metro Rail MRT-6)
├── cng_stand.svg       (3-wheeler auto-rickshaw hub)
├── bus_terminal.svg    (Sayedabad, Mohakhali, Gabtoli)
├── hospital.svg        (Emergency medical facilities)
├── pharmacy.svg        (Model medicine shops)
├── school.svg          (Primary/Secondary schools)
└── bazaar.svg          (Kitchen markets / কাঁচাবাজার)
             │
             ▼
[ spritetext / spritezero-cli ]
             │
             ├── sprite.png & sprite.json (Standard 1x DPI)
             └── sprite@2x.png & sprite@2x.json (Retina 2x DPI)
```

Hosted under `https://tiles.ride.com/sprites/sprite`.

---

## 5. Phase 3: Planetiler National PMTiles Compilation

**PMTiles (ProtoMaps Tiles)** is a single-file archive format for tile pyramids. Unlike traditional tile servers that run databases or millions of loose files, PMTiles enables querying any vector tile directly over HTTP using standard **HTTP Range Requests** (`Range: bytes=start-end`).

### 5.1 Compilation Command & Flags
Planetiler v0.8.2+ compiles the entire 339 MB Geofabrik Bangladesh extract directly into an OpenMapTiles-compatible PMTiles archive in a single pass:

```bash
#!/usr/bin/env bash
# scripts/build-pmtiles.sh
set -eo pipefail

DATA_DIR="/opt/dpmaps/data"
OUTPUT_DIR="/opt/dpmaps/cartography"
PLANETILER_JAR="/opt/dpmaps/tools/planetiler.jar"

mkdir -p "${OUTPUT_DIR}"
cd "${DATA_DIR}"

echo "=== Downloading Planetiler v0.8.2 ==="
if [ ! -f "${PLANETILER_JAR}" ]; then
  mkdir -p "/opt/dpmaps/tools"
  curl -sSL "https://github.com/onthegomap/planetiler/releases/download/v0.8.2/planetiler.jar" -o "${PLANETILER_JAR}"
fi

echo "=== Compiling bangladesh.pmtiles (Zoom 0 to 14) ==="
# Bounding box coordinates: Bangladesh [minLng, minLat, maxLng, maxLat]
BBOX="88.01,20.57,92.68,26.63"

java -Xmx8g -XX:+UseG1GC -jar "${PLANETILER_JAR}" \
  --osm-path="${DATA_DIR}/bangladesh-latest.osm.pbf" \
  --output="${OUTPUT_DIR}/bangladesh.pmtiles" \
  --bounds="${BBOX}" \
  --max-zoom=14 \
  --min-zoom=0 \
  --nodemap-type=sparsearray \
  --storage=mmap \
  --download=false

echo "=== Verifying PMTiles Archive Header & Metadata ==="
npx pmtiles show "${OUTPUT_DIR}/bangladesh.pmtiles"

echo "=== Verification complete. Archive size: ==="
ls -lh "${OUTPUT_DIR}/bangladesh.pmtiles"
```

### 5.2 Archive Specifications
- **Input:** 339 MB `bangladesh-latest.osm.pbf` (Geofabrik).
- **Output:** ~350–390 MB `bangladesh.pmtiles`.
- **Zoom Range:** Z0 through Z14 (Z14 provides full building footprints, residential lanes, and water bodies).
- **Build Time:** ~12–18 minutes on an 8-vCPU / 16 GB RAM build instance.

---

## 6. Cloudflare R2 Edge Storage Topology & Cache Configuration

Cloudflare R2 provides S3-compatible object storage with **zero egress fees**. Proxied behind Cloudflare CDN, HTTP byte-range requests are cached at global edge PoPs, ensuring sub-50ms tile response times on Dhaka mobile networks (Grameenphone, Robi, Banglalink).

```
                      [ Passenger / Driver Mobile Client ]
                                        │
                                        ▼ (HTTP GET Range: bytes=1048576-1052672)
                      [ Cloudflare Edge CDN (DAC / SIN PoP) ]
                                        │
                         ┌──────────────┴──────────────┐
                         ▼ (Cache Hit)                 ▼ (Cache Miss)
                    [ Edge Cache ]           [ Cloudflare R2: dpmaps-tiles ]
                    (0ms Origin Latency)     (Zero Egress Fees)
                                             ├── bangladesh.pmtiles (~370 MB)
                                             ├── glyphs/
                                             │    ├── Noto Sans Bengali Regular/
                                             │    └── Noto Sans Bengali Bold/
                                             └── sprites/
                                                  ├── sprite.png & sprite.json
                                                  └── sprite@2x.png & sprite@2x.json
```

### 6.1 Cloudflare CDN Edge Cache Rules
To ensure PMTiles byte ranges and glyphs are cached effectively:
1. **PMTiles Byte-Range Cache Rule:**
   - **Target:** `tiles.ride.com/bangladesh.pmtiles`
   - **Cache Level:** Cache Everything
   - **Edge Cache TTL:** 30 days (`public, max-age=2592000, immutable`)
   - **Range Request Handling:** Cloudflare automatically caches sub-slices of the PMTiles archive as users pan and zoom.
2. **Glyphs Cache Rule:**
   - **Target:** `tiles.ride.com/glyphs/*`
   - **Edge Cache TTL:** 1 year (`public, max-age=31536000, immutable`)
3. **Sprites Cache Rule:**
   - **Target:** `tiles.ride.com/sprites/*`
   - **Edge Cache TTL:** 24 hours (`public, max-age=86400`)

### 6.2 Cloudflare R2 CORS Policy
```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "If-Match", "If-None-Match"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

---

## 7. Bilingual MapLibre Vector Style (`style.json`)

The client consumes a tailored vector style hosted at `https://tiles.ride.com/styles/dpmaps-light.json`. It implements a robust bilingual display hierarchy ensuring Bengali text is displayed primarily, with clean English fallbacks.

```json
{
  "version": 8,
  "name": "dpMaps Sovereign Light",
  "metadata": {
    "maputnik:renderer": "mbgljs"
  },
  "sources": {
    "openmaptiles": {
      "type": "vector",
      "url": "pmtiles://https://tiles.ride.com/bangladesh.pmtiles"
    }
  },
  "glyphs": "https://tiles.ride.com/glyphs/{fontstack}/{range}.pbf",
  "sprite": "https://tiles.ride.com/sprites/sprite",
  "layers": [
    {
      "id": "background",
      "type": "background",
      "paint": { "background-color": "#f8f9fa" }
    },
    {
      "id": "water",
      "type": "fill",
      "source": "openmaptiles",
      "source-layer": "water",
      "paint": { "fill-color": "#cce5ff" }
    },
    {
      "id": "road_primary",
      "type": "line",
      "source": "openmaptiles",
      "source-layer": "transportation",
      "filter": ["in", "class", "primary", "secondary", "trunk"],
      "paint": {
        "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 6]
      }
    },
    {
      "id": "place_label_bilingual",
      "type": "symbol",
      "source": "openmaptiles",
      "source-layer": "place",
      "layout": {
        "text-field": [
          "case",
          ["all", ["has", "name:bn"], ["has", "name:en"], ["!=", ["get", "name:bn"], ["get", "name:en"]]],
          ["concat", ["get", "name:bn"], "\n", ["get", "name:en"]],
          ["coalesce", ["get", "name:bn"], ["get", "name"], ["get", "name:en"], ""]
        ],
        "text-font": ["Noto Sans Bengali Regular", "Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 8, 11, 14, 15],
        "text-line-height": 1.2,
        "text-max-width": 9
      },
      "paint": {
        "text-color": "#1f2937",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.5
      }
    },
    {
      "id": "poi_landmark_icons",
      "type": "symbol",
      "source": "openmaptiles",
      "source-layer": "poi",
      "layout": {
        "icon-image": ["concat", ["get", "class"], "_icon"],
        "icon-size": 0.8,
        "text-field": ["coalesce", ["get", "name:bn"], ["get", "name"]],
        "text-font": ["Noto Sans Bengali Regular"],
        "text-offset": [0, 1.2],
        "text-size": 11
      },
      "paint": {
        "text-color": "#374151",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.2
      }
    }
  ]
}
```

---

## 8. Mobile Client Integration & Offline Bundling Strategy

### 8.1 Protocol Registration (React Native / Android / iOS)
Mobile applications register the `pmtiles://` protocol adapter via `@maplibre/maplibre-react-native` or the native MapLibre SDK file source:

```typescript
// mobile/src/map/pmtilesProtocol.ts
import { Protocol } from 'pmtiles';
import MapLibreGL from '@maplibre/maplibre-react-native';

export function initializeMapLibrePMTiles(): void {
  const protocol = new Protocol();
  MapLibreGL.addCustomHeader('pmtiles', (url) => {
    return protocol.tile;
  });
}
```

### 8.2 Compact Pre-Packaged Offline Basemap (~45 MB)
To provide an instantaneous, zero-network first-open experience:
1. A compact `dhaka_core_z11.pmtiles` archive (~45 MB, covering Greater Dhaka up to Zoom 11) is bundled directly into the mobile application assets (`android/app/src/main/assets/`).
2. When the app boots with poor or zero connectivity, MapLibre mounts the local asset file (`pmtiles://file:///android_asset/dhaka_core_z11.pmtiles`).
3. When the device is online and zooms beyond Z11, the client seamlessly fetches high-zoom tiles (Z12–Z14) from `https://tiles.ride.com/bangladesh.pmtiles`.

---

## 9. Deliverables & Definition of Done

- [ ] **Phase 0 Deliverable:** Bengali SDF glyphs generated for `Noto Sans Bengali Regular` and `Noto Sans Bengali Bold` covering ranges `0-255.pbf` and `2304-2559.pbf`.
- [ ] **Phase 0 Deliverable:** Verified rendering of all Bengali numerals (`০-৯`), matras, and conjuncts (ক্ষ, জ্ঞ) with zero "tofu" boxes or broken rendering artifacts.
- [ ] **Phase 0 Deliverable:** Custom Dhaka POI category sprites (Mosque, MRT, CNG, Bus, Hospital) compiled and published to `https://tiles.ride.com/sprites/`.
- [ ] **Phase 3 Deliverable:** Planetiler v0.8.2+ compilation pipeline tested on 339 MB Geofabrik extract; produces verified `bangladesh.pmtiles` archive (~350–390 MB).
- [ ] **Phase 3 Deliverable:** Cloudflare R2 bucket `dpmaps-tiles` configured with CORS and CDN edge range-request caching rules.
- [ ] **Phase 3 Deliverable:** Bilingual MapLibre vector style deployed with dynamic stacked expressions (`name:bn` + `name:en`).
- [ ] Mobile MapLibre integration tested on Android and iOS handsets; demonstrates sub-50ms tile delivery over local cellular connections (Grameenphone, Robi).
- [ ] Offline bundling tested: 45 MB Z0–Z11 basemap renders instantly from local handset storage without network access.
