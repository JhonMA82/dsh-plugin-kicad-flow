import type { CircuitIR } from './ir.js';

/** ERC-driver artifacts (kicad-flow 0.2.7).
 *
 * A `powerDriven: true` net declares explicit designer intent that the net
 * is legitimately powered. The compiler materializes exactly one
 * `power:PWR_FLAG` per such net. Artifacts are NOT functional components:
 * reconciliation keeps `expectedComponents` at the IR count and tracks
 * artifacts separately (missing / misattached / unexpected all fail).
 *
 * Reference namespace `#PWR##` can never collide with IR refs: `REF_RE`
 * requires references to start with a letter.
 */

export const PWR_FLAG_SYMBOL = 'power:PWR_FLAG';
export const PWR_FLAG_PIN = '1';
export const PWR_FLAG_VALUE = 'PWR_FLAG';

export interface ExpectedArtifact {
  ref: string;
  symbol: string;
  pin: string;
  net: string;
}

/** Deterministic artifact list: powerDriven nets sorted by net name map to
 * `#PWR01`, `#PWR02`, … — identical on every run for the same IR. */
export function expectedPowerFlags(design: CircuitIR): ExpectedArtifact[] {
  return design.nets
    .filter((net) => net.erc?.powerDriven === true)
    .map((net) => net.name)
    .sort()
    .map((name, index) => ({
      ref: `#PWR${String(index + 1).padStart(2, '0')}`,
      symbol: PWR_FLAG_SYMBOL,
      pin: PWR_FLAG_PIN,
      net: name,
    }));
}

/** Nets explicitly declared as ERC-driven. */
export function powerDrivenNetNames(design: CircuitIR): string[] {
  return expectedPowerFlags(design).map((a) => a.net);
}
