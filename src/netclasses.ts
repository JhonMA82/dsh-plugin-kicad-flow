import { promises as fs } from 'node:fs';
import type { CircuitIR, NetclassRule } from './ir.js';
import { defaultNetclasses } from './ir.js';

interface ProjectJson {
  net_settings?: {
    classes?: Array<Record<string, unknown>>;
    netclass_patterns?: Array<Record<string, unknown>>;
    netclass_assignments?: Record<string, string[]> | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function inferredNetclass(design: CircuitIR, netName: string): string | undefined {
  const explicit = design.nets.find((n) => n.name === netName)?.class;
  if (explicit) return explicit;
  if (design.project.profile !== 'automotive') return undefined;
  if (/12V|BAT|VBAT|VIN/i.test(netName)) return 'Power_12V';
  if (/5V|VCC|VDD/i.test(netName)) return 'Power_5V';
  if (/ECT|SENS|ADC|SIG|TEMP/i.test(netName)) return 'Sensor_Signal';
  return 'Logic_Default';
}

/**
 * 0.3.0: resolve EXPLICIT net classes only. Profile defaults (automotive
 * Power_12V/Power_5V/Sensor_Signal/Logic_Default) and name-regex inference
 * are deliberately NOT applied: if a design needs a special rule the IR must
 * declare it, otherwise the compiler reports the gap instead of inventing
 * automotive rules. Membership still expands from explicit sources:
 * rule.nets entries and nets whose `class` field names a declared rule.
 */
export function explicitNetclasses(design: CircuitIR): NetclassRule[] {
  const declared = design.netclasses ?? [];
  if (!declared.length) return [];
  const byName = new Map(declared.map((rule) => [rule.name, rule]));
  const membership = new Map<string, Set<string>>(declared.map((rule) => [rule.name, new Set(rule.nets ?? [])]));
  for (const net of design.nets) {
    if (!net.class) continue;
    if (!byName.has(net.class)) continue; // undeclared class: reported, never invented
    membership.get(net.class)!.add(net.name);
  }
  return declared.map((rule) => ({ ...rule, nets: [...membership.get(rule.name)!].sort() }));
}

/**
 * Resolve the user-facing rules into explicit net assignments. The LLM never
 * needs to call KiCad netclass tools or repeat the net list itself.
 */
export function resolvedNetclasses(design: CircuitIR): NetclassRule[] {
  const base = design.netclasses?.length
    ? design.netclasses
    : design.project.profile === 'automotive'
      ? defaultNetclasses('automotive')
      : [];

  return base.map((rule) => {
    const nets = new Set(rule.nets ?? []);
    for (const net of design.nets) {
      if (inferredNetclass(design, net.name) === rule.name) nets.add(net.name);
    }
    return { ...rule, nets: [...nets].sort() };
  });
}

export function mergeNetclasses(project: ProjectJson, design: CircuitIR): ProjectJson {
  const out: ProjectJson = JSON.parse(JSON.stringify(project));
  const ns = (out.net_settings ??= {});
  const existing = Array.isArray(ns.classes) ? ns.classes : [];
  const desired = resolvedNetclasses(design);
  if (!desired.length) return out;

  const byName = new Map(existing.map((x) => [String(x.name ?? ''), x]));
  const merged = desired.map((rule) => ({
    ...(byName.get(rule.name) ?? {}),
    name: rule.name,
    clearance: rule.clearanceMm,
    track_width: rule.trackWidthMm,
    via_diameter: rule.viaDiameterMm ?? 0.6,
    via_drill: rule.viaDrillMm ?? 0.3,
  }));

  const untouched = existing.filter((x) => !desired.some((d) => d.name === x.name));
  ns.classes = [...untouched, ...merged];

  // KiCad 9/10 persists explicit net -> class membership here. Keep patterns
  // too for compatibility with projects created by older KiCad builds.
  const assignments: Record<string, string[]> = {};
  const patterns: Array<{ netclass: string; pattern: string }> = [];
  for (const rule of desired) {
    for (const net of rule.nets ?? []) {
      assignments[net] = [rule.name];
      patterns.push({ netclass: rule.name, pattern: net });
    }
  }
  ns.netclass_assignments = assignments;
  ns.netclass_patterns = patterns;
  return out;
}

/** Fallback for MCP versions that do not expose create_netclass. */
export async function applyNetclasses(projectPath: string, design: CircuitIR): Promise<void> {
  const desired = resolvedNetclasses(design);
  if (!desired.length) return;
  const raw = await fs.readFile(projectPath, 'utf8');
  const merged = mergeNetclasses(JSON.parse(raw), design);
  await fs.writeFile(projectPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}
