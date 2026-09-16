/** Pin-identity helpers for kicad-flow 0.2.6.
 *
 * Bug class fixed here (vcm-controller K1): the 0.2.5 compiler forwarded IR
 * pin selectors to `batch_connect` without ever checking them against the
 * strict symbol preflight it already performed. A relay using multi-digit
 * numeric pins (`11`, `12`, `14`) and alphanumeric coil pins (`A1`, `A2`)
 * was silently skipped per-endpoint while the rest of each batch succeeded.
 *
 * 0.2.6 policy: pin identifiers are opaque strings end to end (never
 * coerced to numbers), and every IR endpoint must resolve against the
 * preflight pin list BEFORE any schematic mutation. Unknown pins stop the
 * compile loudly instead of producing unconnected nets.
 */

export interface PreflightPin {
  number: string;
  name: string;
  type: string;
  x?: number;
  y?: number;
  angle?: number;
}

export interface PreflightSymbol {
  symbol: string;
  pinCount: number;
  /** Keyed by pin number as an opaque string (`"11"`, `"A1"`). */
  pins: Map<string, PreflightPin>;
  /** True when the server returned only a symmetric summary without pin detail. */
  pinsOmitted: boolean;
}

/** Preserve the exact IR spelling of a pin selector. Never Number(). */
export function normalizePinId(pin: unknown): string {
  return String(pin).trim();
}

const HEADER_RE = /^(.+?)\s+—\s+(\d+)\s+pin\(s\)(.*)$/;
const PIN_RE = /^\s*Pin\s+(\S+)\s+\(([^)]*)\)\s+—\s+type:\s*([^\s]+)(?:\s+at\s+\(([-\d.eE+]+),([-\d.eE+]+)\)\s+angle=([-\d.eE+]+))?/;

function finiteOrUndefined(v: number): number | undefined {
  return Number.isFinite(v) ? v : undefined;
}

/** Parse the human-readable `batch_list_symbol_pins` / `list_symbol_pins`
 * text into structured per-symbol pin data. Defensive: unparseable lines are
 * ignored, but a symbol with no usable pin data is reported as omitted. */
export function parseSymbolPinPreflight(text: string): Map<string, PreflightSymbol> {
  const out = new Map<string, PreflightSymbol>();
  let current: PreflightSymbol | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const header = line.match(HEADER_RE);
    if (header) {
      const symbol = (header[1] ?? '').trim();
      const pinCount = Number.parseInt(header[2] ?? '0', 10);
      const trailer = header[3] ?? '';
      current = {
        symbol,
        pinCount: Number.isFinite(pinCount) ? pinCount : 0,
        pins: new Map(),
        pinsOmitted: /symmetric/i.test(trailer),
      };
      out.set(symbol, current);
      continue;
    }
    if (!current || current.pinsOmitted) continue;
    const pin = line.match(PIN_RE);
    if (!pin) continue;
    const number = normalizePinId(pin[1]);
    current.pins.set(number, {
      number,
      name: (pin[2] ?? '').trim(),
      type: (pin[3] ?? '').trim(),
      x: pin[4] !== undefined ? finiteOrUndefined(Number(pin[4])) : undefined,
      y: pin[5] !== undefined ? finiteOrUndefined(Number(pin[5])) : undefined,
      angle: pin[6] !== undefined ? finiteOrUndefined(Number(pin[6])) : undefined,
    });
  }
  return out;
}

export interface UnknownPin {
  ref: string;
  pin: string;
  symbol: string;
}

export interface PinVerification {
  ok: boolean;
  unknownPins: UnknownPin[];
  unverifiedSymbols: string[];
}

/** Verify that every IR endpoint pin exists in the preflight pin data.
 * Generic: no per-symbol exceptions. Symmetric passives reported without
 * pin detail fall back to accepting integer pins within the pin count. */
export function verifyDesignPins(
  components: Array<{ ref: string; symbol: string }>,
  nets: Array<{ name: string; pins: Array<{ ref: string; pin: string }> }>,
  preflight: Map<string, PreflightSymbol>,
): PinVerification {
  const byRef = new Map(components.map((c) => [c.ref, c]));
  const unknownPins: UnknownPin[] = [];
  const unverifiedSymbols: string[] = [];
  const seenUnverified = new Set<string>();
  for (const net of nets) {
    for (const endpoint of net.pins) {
      const component = byRef.get(endpoint.ref);
      if (!component) continue; // IR validation already rejects unknown refs.
      const pin = normalizePinId(endpoint.pin);
      const entry = preflight.get(component.symbol);
      if (!entry || (entry.pins.size === 0 && !entry.pinsOmitted)) {
        unknownPins.push({ ref: endpoint.ref, pin, symbol: component.symbol });
        continue;
      }
      if (entry.pins.has(pin)) continue;
      if (entry.pinsOmitted) {
        if (!seenUnverified.has(component.symbol)) {
          seenUnverified.add(component.symbol);
          unverifiedSymbols.push(component.symbol);
        }
        if (/^\d+$/.test(pin)) {
          const n = Number.parseInt(pin, 10);
          if (n >= 1 && n <= entry.pinCount) continue;
        }
      }
      unknownPins.push({ ref: endpoint.ref, pin, symbol: component.symbol });
    }
  }
  return { ok: unknownPins.length === 0, unknownPins, unverifiedSymbols };
}

export function formatUnknownPins(unknown: UnknownPin[]): string {
  return unknown.slice(0, 12).map((u) => `${u.ref}:${u.pin} (symbol ${u.symbol})`).join(', ');
}
