/**
 * vendorClientWrapper.ts — Stage 002 isolated vendor client wrapper.
 *
 * Clean-room invariant (Hard Rule 1): the raw vendor HTTP response NEVER leaves
 * the private function scope below. The wrapper parses it in ephemeral volatile
 * memory and emits only strictly typed, minimal DTOs containing numbers and
 * enums. Suggestion display text and route polylines are RESPONSE-ONLY: they
 * travel to the handset UI and are never logged, stored, or forwarded to
 * telemetry, evaluation datasets, or gazetteer pipelines.
 *
 * No vendor SDK is imported here. The two `callPrivate*` functions are the ONLY
 * Everything else in the codebase talks to the fetchSafeVendorSuggestions,
 * resolveVendorSelection, and executeBarikoiRoute functions below.
 */

import { randomUUID } from 'node:crypto';

export type VendorProvider = 'barikoi' | 'google';
export type VendorRouteStatus = 'OK' | 'NO_ROUTE' | 'TIMEOUT' | 'ERROR';

/** Minimal route DTO: numbers + enums only. Polyline is response-only (handset view). */
export interface SafeVendorRouteResult {
  distance_meters: number;
  duration_seconds: number;
  /** Ephemeral handset view only. Never persisted, logged, or used for training. */
  polyline?: string;
  provider: VendorProvider;
  status: VendorRouteStatus;
  http_status: number;
  latency_ms: number;
}

/**
 * Minimal suggestion DTO. Coordinates and vendor place IDs are STRICTLY
 * omitted — dispatch resolves them via resolveVendorSelection() only.
 * Display strings are response-only (mobile UI rendering).
 */
export interface SafeVendorSuggestion {
  /** Ephemeral random token (UUID v4), single-use, 120s TTL. */
  temp_client_id: string;
  /** Response-only: immediate mobile UI rendering. Never logged/stored. */
  display_name: string;
  /** Response-only: immediate mobile UI rendering. Never logged/stored. */
  secondary_text: string;
  category: string;
}

/** Minimal ephemeral-cache surface (Redis in production, in-memory fake in tests). */
export interface EphemeralCache {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  /** Atomic get-and-delete. Must return null when expired or already consumed. */
  getdel(key: string): Promise<string | null>;
}

/** Logger surface restricted to wrapper-generated enums/numbers (see logSafeDiagnostics). */
export interface SafeLogger {
  info(event: Record<string, string | number>): void;
}

/** TTL for single-use dispatch resolution tokens (Stage 002 §4). */
export const VENDOR_RESOLVE_TTL_SECONDS = 120;

/** Key namespace for single-use dispatch resolution tokens. */
export const VENDOR_RESOLVE_PREFIX = 'vendor:resolve:';

/** Loose shape of a raw vendor prediction. Stays inside this module — never exported. */
interface RawVendorPrediction {
  latitude?: unknown;
  longitude?: unknown;
  title?: unknown;
  name?: unknown;
  address?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any;
}

/**
 * PRIVATE transport seam — autocomplete. Production wires the real vendor SDK
 * here. The resolved value never escapes fetchSafeVendorSuggestions().
 */
async function callPrivateVendorAutocompleteApi(
  _query: string,
  _userLoc?: { lat: number; lng: number },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  throw new Error(
    'vendor transport not configured: wire callPrivateVendorAutocompleteApi to the approved vendor SDK',
  );
}

/**
 * PRIVATE transport seam — route. Production wires the real vendor SDK here.
 * The resolved value never escapes executeBarikoiRoute().
 */
async function callPrivateVendorApi(
  _origin: { lat: number; lng: number },
  _dest: { lat: number; lng: number },
  _timeoutMs: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  throw new Error(
    'vendor transport not configured: wire callPrivateVendorApi to the approved vendor SDK',
  );
}

/**
 * Diagnostic logger emitting ONLY wrapper-generated enums and numbers.
 * Free-text fields (error_message, url_path, endpoint, request_id, query,
 * coordinates, place IDs) are strictly dropped — never passed here.
 */
export function logSafeDiagnostics(
  logger: SafeLogger,
  provider: VendorProvider,
  status: VendorRouteStatus,
  httpStatus: number,
  latencyMs: number,
): void {
  logger.info({
    event: 'external_vendor_call',
    provider,
    status,
    http_status: httpStatus,
    latency_ms: latencyMs,
  });
}

/**
 * Server-side suggestion fetcher: calls the vendor autocomplete API, caches
 * destination coordinates ephemerally (120s TTL) for dispatch resolution, and
 * emits coordinate-withheld DTOs. Raw vendor payloads never leave this scope.
 */
export async function fetchSafeVendorSuggestions(
  query: string,
  userLoc: { lat: number; lng: number } | undefined,
  cache: EphemeralCache,
  logger: SafeLogger,
): Promise<SafeVendorSuggestion[]> {
  const started = Date.now();
  let rawVendorResults: { predictions?: RawVendorPrediction[] };
  try {
    rawVendorResults = await callPrivateVendorAutocompleteApi(query, userLoc);
  } catch {
    logSafeDiagnostics(logger, 'barikoi', 'ERROR', 500, Date.now() - started);
    return [];
  }

  if (!rawVendorResults || !Array.isArray(rawVendorResults.predictions)) {
    return [];
  }

  const safeSuggestions: SafeVendorSuggestion[] = [];
  for (const item of rawVendorResults.predictions) {
    const tempClientId = randomUUID();
    const lat = Number(item.latitude);
    const lng = Number(item.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    // Ephemeral dispatch coordinates only. TTL 120s, single-use via GETDEL.
    await cache.set(
      `${VENDOR_RESOLVE_PREFIX}${tempClientId}`,
      JSON.stringify({ lat, lng }),
      'EX',
      VENDOR_RESOLVE_TTL_SECONDS,
    );
    // Safe DTO strictly withholds coordinates and vendor place IDs.
    safeSuggestions.push({
      temp_client_id: tempClientId,
      display_name: String(item.title ?? item.name ?? ''),
      secondary_text: String((item as { address?: unknown }).address ?? ''),
      category: 'general',
    });
  }
  return safeSuggestions;
}

/**
 * Server-side single-use resolution: turns a rider's tapped suggestion into
 * destination coordinates for the dispatch module ONLY. Atomic GETDEL prevents
 * concurrent duplicate consumption. Returns null when the token expired
 * (>120s) or was already consumed — the client must prompt re-selection.
 * The system NEVER falls back to storage.
 */
export async function resolveVendorSelection(
  cache: EphemeralCache,
  temp_client_id: string,
): Promise<{ lat: number; lng: number } | null> {
  if (!temp_client_id || typeof temp_client_id !== 'string') {
    return null;
  }
  const raw = await cache.getdel(`${VENDOR_RESOLVE_PREFIX}${temp_client_id}`);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { lat?: unknown; lng?: unknown };
    const lat = Number(parsed.lat);
    const lng = Number(parsed.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }
    return { lat, lng };
  } catch {
    return null;
  }
}

export interface SafeRouteOrigin {
  lat: number;
  lng: number;
}

/**
 * Barikoi route call through the isolated wrapper. Parses the raw vendor
 * response in ephemeral scope and returns numbers + status only. Logs only
 * wrapper-generated enums/numbers via logSafeDiagnostics.
 */
export async function executeBarikoiRoute(
  origin: SafeRouteOrigin,
  dest: SafeRouteOrigin,
  timeoutMs: number,
  logger: SafeLogger,
): Promise<SafeVendorRouteResult | null> {
  const start = Date.now();
  let httpStatus = 0;
  try {
    const rawResponse = await callPrivateVendorApi(origin, dest, timeoutMs);
    httpStatus = Number(rawResponse?.status ?? 0);
    const latencyMs = Date.now() - start;
    const parsed = rawResponse?.data;
    if (!rawResponse?.ok || !parsed) {
      logSafeDiagnostics(logger, 'barikoi', 'ERROR', httpStatus, latencyMs);
      return null;
    }
    logSafeDiagnostics(logger, 'barikoi', 'OK', httpStatus, latencyMs);
    return {
      distance_meters: Number(parsed.distance) || 0,
      duration_seconds: Math.round(Number(parsed.duration) || 0),
      polyline: typeof parsed.route === 'string' ? parsed.route : undefined,
      provider: 'barikoi',
      status: 'OK',
      http_status: httpStatus,
      latency_ms: latencyMs,
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const status: VendorRouteStatus =
      err instanceof Error && err.name === 'AbortError' ? 'TIMEOUT' : 'ERROR';
    logSafeDiagnostics(logger, 'barikoi', status, httpStatus || 500, latencyMs);
    return null;
  }
}

const BENGALI_DIGIT_MAP: Record<string, string> = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
};

/**
 * scrubPii — the cross-stage PII filtering contract (Stage 002 §2.2 & Stage 007 §3).
 * Converts Bengali numerals to ASCII, strips phone-run separators, and drops
 * Bangladeshi mobile phone numbers (013-019) and emails outright without a shared marker.
 * Preserves short road/house numerals like "road 12 34".
 */
export function scrubPii(rawInput: string): string {
  if (!rawInput || typeof rawInput !== 'string') return '';
  let text = rawInput.normalize('NFC');
  // 1. Fold Bengali digits
  text = text.replace(/[০-৯]/g, (m) => BENGALI_DIGIT_MAP[m] || m);
  // 2. Normalize separators ONLY in 10-13 digit runs
  text = text.replace(/\+?\d(?:[\s\-().+]?\d){9,12}/g, (m) => m.replace(/[\s\-().+]/g, ''));
  // 3. Drop Bangladeshi mobile phone patterns (01[3-9]xxxxxxxx / +8801...)
  text = text.replace(/(?:\+?88)?01[3-9]\d{8}\b/g, ' ');
  // 4. Drop general 9+ consecutive digit runs if not already matched
  text = text.replace(/\b\d{9,}\b/g, ' ');
  // 5. Drop email patterns
  text = text.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

