import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExpectedArtifact } from './artifacts.js';
import type { CircuitIR, CircuitNetPin } from './ir.js';
import { pinOffsetToSchematic } from './layout.js';
import { run } from './process.js';

export interface NetlistNode {
  ref: string;
  pin: string;
  pinFunction?: string;
}

export interface NetlistNet {
  rawName: string;
  name: string;
  nodes: NetlistNode[];
}

export interface SchematicSnapshot {
  componentRefs: string[];
  nets: NetlistNet[];
  /** Compiler-artifact facts parsed from the schematic file itself. KiCad 10
   * netlist export EXCLUDES power symbols entirely (no <comp>, no net nodes),
   * so `#PWR*` artifacts are invisible to the netlist; the schematic text is
   * the only deterministic source for their presence and net attachment.
   * Absent (undefined) = legacy netlist-only snapshot (tests/fallback). */
  schematicArtifacts?: SchematicArtifact[];
}

export interface SchematicArtifact {
  ref: string;
  /** Net attached via the label at the artifact's pin origin, or null. */
  net: string | null;
}

export interface EndpointIssue {
  ref: string;
  pin: string;
}

export interface NetReconciliationIssue {
  name: string;
  expectedCount: number;
  actualCount: number;
  missingEndpoints: EndpointIssue[];
  unexpectedEndpoints: NetlistNode[];
}

export interface ArtifactExpectation {
  ref: string;
  net: string;
}

export interface ReconciliationReport {
  ok: boolean;
  expectedComponents: number;
  actualComponents: number;
  missingComponents: string[];
  unexpectedComponents: string[];
  duplicateReferences: string[];
  expectedNets: number;
  matchedNets: number;
  missingNets: string[];
  netIssues: NetReconciliationIssue[];
  expectedButUnconnected: NetlistNode[];
  unexpectedUnconnected: NetlistNode[];
  allowedNoConnect: NetlistNode[];
  /** Compiler artifacts derived from explicit IR intent (`powerDriven`). */
  expectedArtifacts: ArtifactExpectation[];
  missingArtifacts: string[];
  misattachedArtifacts: ArtifactExpectation[];
  unexpectedArtifacts: string[];
  /** Nets carrying `#PWR`-namespaced nodes (normally exactly the driven set). */
  powerFlagCounts: Array<{ net: string; count: number }>;
}

export type SnapshotProvider = (schematicPath: string) => Promise<SchematicSnapshot>;

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attrs(fragment: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_.:-]*)="([^"]*)"/g;
  for (const match of fragment.matchAll(re)) out[match[1]!] = decodeXml(match[2]!);
  return out;
}

export function normalizeNetName(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

export function parseKiCadNetlistXml(xml: string): SchematicSnapshot {
  const componentRefs: string[] = [];
  for (const match of xml.matchAll(/<comp\s+([^>]*?\bref="[^"]+"[^>]*)>/g)) {
    const a = attrs(match[1]!);
    if (a.ref) componentRefs.push(a.ref);
  }

  const nets: NetlistNet[] = [];
  for (const match of xml.matchAll(/<net\s+([^>]*)>([\s\S]*?)<\/net>/g)) {
    const a = attrs(match[1]!);
    if (!a.name) continue;
    const nodes: NetlistNode[] = [];
    for (const nodeMatch of match[2]!.matchAll(/<node\s+([^>]*?)(?:\/?>)/g)) {
      const n = attrs(nodeMatch[1]!);
      if (!n.ref || !n.pin) continue;
      nodes.push({ ref: n.ref, pin: n.pin, pinFunction: n.pinfunction || n.pin_function || undefined });
    }
    nets.push({ rawName: a.name, name: normalizeNetName(a.name), nodes });
  }
  return { componentRefs, nets };
}

export async function inspectSchematicNetlist(schematicPath: string): Promise<SchematicSnapshot> {
  const flowDir = join(dirname(schematicPath), '.kicad-flow');
  const out = join(flowDir, 'reconcile-netlist.xml');
  await fs.mkdir(flowDir, { recursive: true });
  await run('kicad-cli', ['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', out, schematicPath]);
  const snapshot = parseKiCadNetlistXml(await fs.readFile(out, 'utf8'));
  // Enrich with compiler-artifact facts from the schematic text (0.2.7.1):
  // the netlist export omits power symbols by design, so PWR_FLAG presence
  // and attachment are verified against the schematic itself.
  snapshot.schematicArtifacts = parseSchematicPowerFlags(await fs.readFile(schematicPath, 'utf8'));
  return snapshot;
}

/** Parse `power:PWR_FLAG` instances from schematic text and resolve the net
 * attached to each artifact's pin (label placed at the pin origin by the
 * connection phase). Deterministic text parsing; never mutates anything. */
export function parseSchematicPowerFlags(schematicText: string): SchematicArtifact[] {
  // Embedded library definition: pin-1 offset in symbol-local coordinates.
  const defIndex = schematicText.indexOf('(symbol "power:PWR_FLAG"');
  const defWindow = defIndex >= 0 ? schematicText.slice(defIndex, defIndex + 6000) : '';
  const pinMatch = /\(pin \w+ line\s*\(at ([-\d.]+) ([-\d.]+) \d+\)\s*\(length [-\d.]+\)[\s\S]*?\(number "1"/.exec(defWindow);
  const defPin = pinMatch ? { x: Number(pinMatch[1]), y: Number(pinMatch[2]) } : { x: 0, y: 0 };
  // Labels: local + global, anchored at connection points.
  const labels: Array<{ name: string; x: number; y: number }> = [];
  for (const m of schematicText.matchAll(/\((?:label|global_label) "([^"]+)"\s*\(at ([-\d.]+) ([-\d.]+) \d+\)/g)) {
    labels.push({ name: m[1]!, x: Number(m[2]), y: Number(m[3]) });
  }
  const artifacts: SchematicArtifact[] = [];
  for (const m of schematicText.matchAll(/\(lib_id "power:PWR_FLAG"\)\s*\(at ([-\d.]+) ([-\d.]+) (\d+)\)/g)) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    const rotation = Number(m[3]);
    const refMatch = /\(property "Reference" "([^"]+)"/.exec(schematicText.slice(m.index, m.index + 1500));
    if (!refMatch) continue;
    const ref = refMatch[1]!;
    if (!ref.startsWith('#PWR')) continue;
    const base = pinOffsetToSchematic({ ref, x, y, rotation }, defPin);
    let net: string | null = null;
    for (const label of labels) {
      if (Math.abs(label.x - base.x) <= 0.05 && Math.abs(label.y - base.y) <= 0.05) {
        net = label.name;
        break;
      }
    }
    artifacts.push({ ref, net });
  }
  artifacts.sort((a, b) => (a.ref < b.ref ? -1 : 1));
  return artifacts;
}

function nodeMatchesPin(node: NetlistNode, endpoint: CircuitNetPin | EndpointIssue): boolean {
  return node.ref === endpoint.ref && (node.pin === endpoint.pin || node.pinFunction === endpoint.pin);
}

function endpointInDesign(design: CircuitIR, node: NetlistNode): boolean {
  return design.nets.some((net) => net.pins.some((p) => nodeMatchesPin(node, p)));
}

function endpointAllowedNoConnect(design: CircuitIR, node: NetlistNode): boolean {
  const component = design.components.find((c) => c.ref === node.ref);
  return (component?.noConnectPins ?? []).some((pin) => node.pin === pin || node.pinFunction === pin);
}

export function reconcileDesignToSnapshot(
  design: CircuitIR,
  snapshot: SchematicSnapshot,
  artifacts: ExpectedArtifact[] = [],
): ReconciliationReport {
  const expectedRefs = new Set(design.components.map((c) => c.ref));
  const artifactRefs = new Set(artifacts.map((a) => a.ref));
  const artifactNet = new Map(artifacts.map((a) => [a.ref, a.net]));
  const effectiveRefs = new Set([...expectedRefs, ...artifactRefs]);
  const counts = new Map<string, number>();
  for (const ref of snapshot.componentRefs) counts.set(ref, (counts.get(ref) ?? 0) + 1);

  // Schematic-derived artifact facts (0.2.7.1). When present they are the
  // authority for artifact presence and net attachment, because the KiCad
  // netlist export omits power symbols entirely.
  const facts = snapshot.schematicArtifacts;
  const factNet = new Map<string, string | null>();
  if (facts) for (const fact of facts) factNet.set(fact.ref, fact.net);
  // Merge schematic-only physical refs into the census without double
  // counting refs the provider already listed (FakeBridge-style snapshots).
  for (const ref of factNet.keys()) if (!counts.has(ref)) counts.set(ref, 1);

  const missingComponents = [...expectedRefs].filter((ref) => !counts.has(ref)).sort();
  const unexpectedComponents = [...counts.keys()].filter((ref) => !effectiveRefs.has(ref)).sort();
  const duplicateReferences = [...counts.entries()].filter(([, count]) => count > 1).map(([ref]) => ref).sort();

  // Expected compiler artifacts (e.g. PWR_FLAGs) live outside the functional
  // component list but are strictly accounted for.
  const missingArtifacts = artifacts.filter((a) => !counts.has(a.ref)).map((a) => a.ref).sort();
  const presentArtifacts = artifacts.filter((a) => counts.has(a.ref));

  const intentional = new Map<string, NetlistNet>();
  const unconnected: NetlistNode[] = [];
  for (const net of snapshot.nets) {
    if (net.rawName.startsWith('unconnected-')) unconnected.push(...net.nodes);
    else intentional.set(net.name, net);
  }

  const misattachedArtifacts: ArtifactExpectation[] = [];
  const powerFlagCounts: Array<{ net: string; count: number }> = [];
  const unexpectedArtifacts: string[] = [];

  if (facts) {
    // Schematic-facts path (authoritative for artifacts).
    for (const artifact of presentArtifacts) {
      const attached = factNet.get(artifact.ref) ?? null;
      if (attached !== artifact.net) misattachedArtifacts.push({ ref: artifact.ref, net: artifact.net });
    }
    const byNet = new Map<string, number>();
    for (const [ref, net] of factNet) {
      if (!artifactRefs.has(ref)) unexpectedArtifacts.push(`${ref} on ${net ?? 'unattached'}`);
      if (net == null) continue;
      byNet.set(net, (byNet.get(net) ?? 0) + 1);
    }
    for (const [net, count] of byNet) powerFlagCounts.push({ net, count });
    powerFlagCounts.sort((a, b) => (a.net < b.net ? -1 : 1));
  } else {
    // Legacy netlist-only path (KiCad normally hides power symbols here, so
    // this branch mainly serves synthetic test snapshots).
    for (const artifact of presentArtifacts) {
      const host = intentional.get(artifact.net);
      const attached = host?.nodes.some((node) => node.ref === artifact.ref) === true;
      if (!attached) misattachedArtifacts.push({ ref: artifact.ref, net: artifact.net });
    }
    const flagNets = new Set(artifacts.map((a) => a.net));
    const flagCounts = new Map<string, number>();
    for (const net of snapshot.nets) {
      if (net.rawName.startsWith('unconnected-')) continue;
      const count = net.nodes.filter((node) => node.ref.startsWith('#PWR')).length;
      if (count > 0) flagCounts.set(net.name, count);
    }
    for (const [net, count] of flagCounts) powerFlagCounts.push({ net, count });
    powerFlagCounts.sort((a, b) => (a.net < b.net ? -1 : 1));
    for (const [net, named] of intentional) {
      for (const node of named.nodes) {
        if (!node.ref.startsWith('#PWR')) continue;
        if (artifactRefs.has(node.ref) && artifactNet.get(node.ref) === net) continue;
        unexpectedArtifacts.push(`${node.ref} on ${net}`);
      }
    }
    for (const [net, count] of flagCounts) {
      if (!flagNets.has(net)) continue;
      const expected = artifacts.filter((a) => a.net === net).length;
      if (count !== expected && !misattachedArtifacts.some((m) => m.net === net)) {
        unexpectedArtifacts.push(`count ${count} on ${net}, expected ${expected}`);
      }
    }
  }
  unexpectedArtifacts.sort();

  const missingNets: string[] = [];
  const netIssues: NetReconciliationIssue[] = [];
  let matchedNets = 0;

  for (const expected of design.nets) {
    const actual = intentional.get(expected.name);
    if (!actual) {
      missingNets.push(expected.name);
      netIssues.push({
        name: expected.name,
        expectedCount: expected.pins.length,
        actualCount: 0,
        missingEndpoints: expected.pins.map((p) => ({ ref: p.ref, pin: p.pin })),
        unexpectedEndpoints: [],
      });
      continue;
    }

    const used = new Set<number>();
    const missingEndpoints: EndpointIssue[] = [];
    for (const endpoint of expected.pins) {
      const index = actual.nodes.findIndex((node, i) => !used.has(i) && nodeMatchesPin(node, endpoint));
      if (index >= 0) used.add(index);
      else missingEndpoints.push({ ref: endpoint.ref, pin: endpoint.pin });
    }
    const unexpectedEndpoints = actual.nodes.filter(
      (_, i) =>
        !used.has(i)
        // Expected artifact nodes attached to their own net are accounted
        // separately (expectedArtifacts) and must not read as extras here.
        // A misattached artifact stays visible as an unexpected endpoint.
        && !(artifactRefs.has(actual.nodes[i]!.ref) && artifactNet.get(actual.nodes[i]!.ref) === expected.name),
    );
    if (missingEndpoints.length || unexpectedEndpoints.length) {
      netIssues.push({
        name: expected.name,
        expectedCount: expected.pins.length,
        actualCount: actual.nodes.length,
        missingEndpoints,
        unexpectedEndpoints,
      });
    } else matchedNets++;
  }

  // Any named net not represented in the IR is electrically suspicious,
  // except pre-merge intrinsic symbol shorts (0.4.1): some official symbols
  // (e.g. Relay:G5V-1 duplicated COM terminals) place two pins at the same
  // position, so KiCad materializes an auto-named net between them from the
  // moment the symbol is placed. Until batch_connect merges both pins under
  // their common IR-net label, that auto net cannot match the IR. It is
  // tolerated only when EVERY node maps (ref, pin) to one and the same IR
  // net; nodes spanning two different IR nets remain a real short error.
  const irNetOfEndpoint = new Map<string, string>();
  for (const net of design.nets) {
    for (const p of net.pins) irNetOfEndpoint.set(`${p.ref}:${p.pin}`, net.name);
  }
  for (const [name, actual] of intentional) {
    if (design.nets.some((n) => n.name === name)) continue;
    let common: string | undefined;
    let preMergeShort = true;
    for (const node of actual.nodes) {
      const irNet = irNetOfEndpoint.get(`${node.ref}:${node.pin}`);
      if (irNet === undefined) { preMergeShort = false; break; }
      if (common === undefined) common = irNet;
      else if (common !== irNet) { preMergeShort = false; break; }
    }
    if (preMergeShort && common !== undefined) continue;
    netIssues.push({
      name,
      expectedCount: 0,
      actualCount: actual.nodes.length,
      missingEndpoints: [],
      unexpectedEndpoints: actual.nodes,
    });
  }

  const expectedButUnconnected = unconnected.filter((node) => endpointInDesign(design, node));
  // An expected artifact added but not yet connected to its net shows up as
  // an `unconnected-*` node: that is the normal intermediate state between
  // component placement and connection, never a no-connect classification.
  // Its final attachment is enforced by misattachedArtifacts, so pending
  // artifacts are excluded from BOTH informational lists below.
  const pendingArtifact = (node: NetlistNode): boolean => artifactRefs.has(node.ref);
  const allowedNoConnect = unconnected.filter((node) => !endpointInDesign(design, node) && !pendingArtifact(node) && endpointAllowedNoConnect(design, node));
  const unexpectedUnconnected = unconnected.filter((node) => !endpointInDesign(design, node) && !pendingArtifact(node) && !endpointAllowedNoConnect(design, node));

  const ok = missingComponents.length === 0
    && unexpectedComponents.length === 0
    && duplicateReferences.length === 0
    && missingNets.length === 0
    && netIssues.length === 0
    && expectedButUnconnected.length === 0
    && unexpectedUnconnected.length === 0
    && missingArtifacts.length === 0
    && misattachedArtifacts.length === 0
    && unexpectedArtifacts.length === 0;

  return {
    ok,
    expectedComponents: design.components.length,
    actualComponents: snapshot.componentRefs.length,
    missingComponents,
    unexpectedComponents,
    duplicateReferences,
    expectedNets: design.nets.length,
    matchedNets,
    missingNets: missingNets.sort(),
    netIssues,
    expectedButUnconnected,
    unexpectedUnconnected,
    allowedNoConnect,
    expectedArtifacts: artifacts.map((a) => ({ ref: a.ref, net: a.net })),
    missingArtifacts,
    misattachedArtifacts,
    unexpectedArtifacts,
    powerFlagCounts,
  };
}

export async function reconcileSchematic(
  design: CircuitIR,
  schematicPath: string,
  provider: SnapshotProvider = inspectSchematicNetlist,
  artifacts: ExpectedArtifact[] = [],
): Promise<ReconciliationReport> {
  return reconcileDesignToSnapshot(design, await provider(schematicPath), artifacts);
}
