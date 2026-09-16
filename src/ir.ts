export const IR_VERSION = 1 as const;

export type ProjectProfile = 'generic' | 'automotive';
/** Compile targets, in pipeline rank order. 'board' is the 0.3.0 legacy alias
 * for the PCB foundation; 'routed' adds routing + zones + final DRC;
 * 'manufacturing' adds Gerbers/drill/BOM/CPL/manifest on top. */
export type CompileTarget = 'schematic' | 'pcb' | 'board' | 'routed' | 'manufacturing';

export interface Point {
  x: number;
  y: number;
}

export interface CircuitComponent {
  ref: string;
  symbol: string;
  value?: string;
  footprint?: string;
  unit?: number;
  block?: string;
  rotation?: number;
  schematic?: Point & { rotation?: number };
  pcb?: Point & { rotation?: number; layer?: string };
  properties?: Record<string, string>;
  noConnectPins?: string[];
  /** 0.4.0: explicit BOM/CPL opt-outs. Default false. Artifacts (#PWR,
   * power:PWR_FLAG) are always excluded regardless of these flags. */
  excludeFromBom?: boolean;
  excludeFromCpl?: boolean;
}

export interface CircuitNetPin {
  ref: string;
  pin: string;
}

export interface CircuitNetErc {
  /** Explicit designer intent: this net is legitimately powered and must
   * materialize so KiCad ERC considers it driven (exactly one PWR_FLAG).
   * Default false. Never inferred; independent of `global`. */
  powerDriven?: boolean;
}

export interface CircuitNet {
  name: string;
  pins: CircuitNetPin[];
  class?: string;
  global?: boolean;
  erc?: CircuitNetErc;
}

export interface NetclassRule {
  name: string;
  trackWidthMm: number;
  clearanceMm: number;
  viaDiameterMm?: number;
  viaDrillMm?: number;
  nets?: string[];
}

/** 0.4.0 routing configuration. Declared intent only: the compiler never
 * invents a router or router options. */
export interface RoutingSpec {
  /** Router backend identifier. 0.4.0 ships exactly one implementation:
   * 'freerouting' (DSN/SES round-trip through KiCad). */
  backend?: 'freerouting';
  /** Upper bound of autorouter passes handed to the router. */
  maxPasses?: number;
  /** Per-attempt timeout in seconds (default 300). */
  timeoutSeconds?: number;
}

/** 0.4.0 explicit copper zone intent (e.g. GND pour on B.Cu). Nothing is
 * created unless declared here. */
export interface ZoneSpec {
  /** Net the zone attaches to. Must exist in `nets`. */
  net: string;
  /** Copper layer. Must be a real KiCad layer name (e.g. 'B.Cu'). */
  layer: string;
  /** Zone clearance in mm (default: board clearance). */
  clearanceMm?: number;
  /** Minimum filled-copper width in mm (default 0.2). */
  minWidthMm?: number;
  /** Fill style. */
  fill?: 'solid' | 'hatched';
  /** Zone priority (KiCad assigned priority, default 0). */
  priority?: number;
  /** Thermal relief style on pad connections (basic Level-1 subset). */
  thermal?: 'solid' | 'relief';
}

export interface BoardSpec {
  widthMm?: number;
  heightMm?: number;
  marginMm?: number;
  /** Copper layer count. Deterministic default 2; integer 1..32. */
  layers?: number;
  /** Default clearance (mm). Deterministic default 0.2. */
  clearanceMm?: number;
  /** Default track width (mm). Deterministic default 0.25. */
  trackWidthMm?: number;
  /** Default via diameter (mm). Deterministic default 0.6. */
  viaDiameterMm?: number;
  /** Default via drill (mm). Deterministic default 0.3; must be < viaDiameterMm. */
  viaDrillMm?: number;
  autoroute?: boolean;
  routingAttempts?: number;
  gndPours?: boolean;
  groundNet?: string;
  /** 0.4.0: routing configuration. Absent = no routing stage. */
  routing?: RoutingSpec;
}

export interface ManufacturingSpec {
  enabled?: boolean;
  outputDir?: string;
  gerberZip?: boolean;
  bom?: boolean;
  cpl?: boolean;
}

export interface CircuitIR {
  version: 1;
  project: {
    name: string;
    description?: string;
    profile?: ProjectProfile;
  };
  blocks?: string[];
  components: CircuitComponent[];
  nets: CircuitNet[];
  netclasses?: NetclassRule[];
  board?: BoardSpec;
  /** 0.4.0: explicitly declared copper zones. Empty/absent = no zone is
   * ever created (intent must be declared, never inferred). */
  zones?: ZoneSpec[];
  manufacturing?: ManufacturingSpec;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  design?: CircuitIR;
}

const REF_RE = /^[A-Za-z]+[A-Za-z0-9._-]*\d+[A-Za-z0-9._-]*$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function obj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function string(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function cleanStringMap(v: unknown): Record<string, string> | undefined {
  if (!obj(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(v)) {
    if (string(value)) out[k] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function slugProjectName(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'kicad-project';
}

export function validateAndNormalizeIR(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!obj(input)) return { ok: false, errors: [{ path: '$', message: 'Design must be an object.' }], warnings };

  const projectRaw = obj(input.project) ? input.project : {};
  const projectName = string(projectRaw.name) ? slugProjectName(projectRaw.name) : '';
  if (!projectName) errors.push({ path: 'project.name', message: 'A non-empty project name is required.' });

  const profile: ProjectProfile = projectRaw.profile === 'automotive' ? 'automotive' : 'generic';
  const componentsRaw = Array.isArray(input.components) ? input.components : [];
  if (!componentsRaw.length) errors.push({ path: 'components', message: 'At least one component is required.' });

  const refs = new Set<string>();
  const components: CircuitComponent[] = [];
  for (let i = 0; i < componentsRaw.length; i++) {
    const raw = componentsRaw[i];
    const p = `components[${i}]`;
    if (!obj(raw)) {
      errors.push({ path: p, message: 'Component must be an object.' });
      continue;
    }
    const ref = string(raw.ref) ? raw.ref.trim() : '';
    const symbol = string(raw.symbol) ? raw.symbol.trim() : '';
    if (!ref) errors.push({ path: `${p}.ref`, message: 'Reference is required.' });
    else if (!REF_RE.test(ref)) warnings.push({ path: `${p}.ref`, message: `Unusual KiCad reference '${ref}'.` });
    if (refs.has(ref)) errors.push({ path: `${p}.ref`, message: `Duplicate reference '${ref}'.` });
    if (ref) refs.add(ref);
    if (!symbol || !symbol.includes(':')) errors.push({ path: `${p}.symbol`, message: "Symbol must use 'Library:Symbol' form." });

    const schematicRaw = obj(raw.schematic) ? raw.schematic : undefined;
    const pcbRaw = obj(raw.pcb) ? raw.pcb : undefined;
    const schematic = schematicRaw && finite(schematicRaw.x) && finite(schematicRaw.y)
      ? { x: schematicRaw.x, y: schematicRaw.y, rotation: finite(schematicRaw.rotation) ? schematicRaw.rotation : undefined }
      : undefined;
    const pcb = pcbRaw && finite(pcbRaw.x) && finite(pcbRaw.y)
      ? {
          x: pcbRaw.x,
          y: pcbRaw.y,
          rotation: finite(pcbRaw.rotation) ? pcbRaw.rotation : undefined,
          layer: string(pcbRaw.layer) ? pcbRaw.layer : undefined,
        }
      : undefined;

    components.push({
      ref,
      symbol,
      value: string(raw.value) ? raw.value : undefined,
      footprint: string(raw.footprint) ? raw.footprint : undefined,
      unit: finite(raw.unit) ? Math.max(1, Math.trunc(raw.unit)) : undefined,
      block: string(raw.block) ? raw.block : undefined,
      rotation: finite(raw.rotation) ? raw.rotation : undefined,
      schematic,
      pcb,
      properties: cleanStringMap(raw.properties),
      noConnectPins: Array.isArray(raw.noConnectPins)
        ? raw.noConnectPins.filter(string).map((x) => x.trim())
        : undefined,
      excludeFromBom: raw.excludeFromBom === true,
      excludeFromCpl: raw.excludeFromCpl === true,
    });
  }

  const netsRaw = Array.isArray(input.nets) ? input.nets : [];
  const netNames = new Set<string>();
  const pinOwners = new Map<string, string>();
  const nets: CircuitNet[] = [];
  for (let i = 0; i < netsRaw.length; i++) {
    const raw = netsRaw[i];
    const p = `nets[${i}]`;
    if (!obj(raw)) {
      errors.push({ path: p, message: 'Net must be an object.' });
      continue;
    }
    const name = string(raw.name) ? raw.name.trim() : '';
    if (!name) errors.push({ path: `${p}.name`, message: 'Net name is required.' });
    if (netNames.has(name)) errors.push({ path: `${p}.name`, message: `Duplicate net '${name}'.` });
    if (name) netNames.add(name);
    if (name && !NAME_RE.test(name)) warnings.push({ path: `${p}.name`, message: `Net '${name}' contains unusual characters.` });

    const pinsRaw = Array.isArray(raw.pins) ? raw.pins : [];
    if (pinsRaw.length < 1) warnings.push({ path: `${p}.pins`, message: `Net '${name}' has no pins.` });
    const pins: CircuitNetPin[] = [];
    for (let j = 0; j < pinsRaw.length; j++) {
      const pr = pinsRaw[j];
      if (!obj(pr) || !string(pr.ref) || !string(pr.pin)) {
        errors.push({ path: `${p}.pins[${j}]`, message: 'Each pin must contain ref and pin strings.' });
        continue;
      }
      const ref = pr.ref.trim();
      const pin = pr.pin.trim();
      if (!refs.has(ref)) errors.push({ path: `${p}.pins[${j}].ref`, message: `Unknown component '${ref}'.` });
      const key = `${ref}/${pin}`;
      const previous = pinOwners.get(key);
      if (previous && previous !== name) {
        errors.push({ path: `${p}.pins[${j}]`, message: `${key} is assigned to both '${previous}' and '${name}'.` });
      } else pinOwners.set(key, name);
      pins.push({ ref, pin });
    }
    const ercRaw = obj(raw.erc) ? raw.erc : undefined;
    let erc: CircuitNetErc | undefined;
    if (ercRaw !== undefined) {
      if (typeof ercRaw.powerDriven !== 'boolean') {
        errors.push({ path: `${p}.erc.powerDriven`, message: `Net '${name}' erc.powerDriven must be a boolean when present.` });
      } else if (ercRaw.powerDriven === true) {
        erc = { powerDriven: true };
      }
    }
    nets.push({
      name,
      pins,
      class: string(raw.class) ? raw.class : undefined,
      global: raw.global === true,
      erc,
    });
  }

  const blocks = Array.isArray(input.blocks) ? input.blocks.filter(string).map((x) => x.trim()) : undefined;
  const boardRaw = obj(input.board) ? input.board : {};
  // 0.3.0: PCB foundation constraints. Every value is either explicitly
  // declared in the IR or filled by a documented deterministic default —
  // nothing is inferred from the project profile.
  const boardLayers = finite(boardRaw.layers) ? boardRaw.layers : 2;
  if (!Number.isInteger(boardRaw.layers ?? 2) || boardLayers < 1 || boardLayers > 32) {
    errors.push({ path: 'board.layers', message: `board.layers must be an integer between 1 and 32 (got ${String(boardRaw.layers)}).` });
  }
  const positive = (path: string, raw: unknown, fallback: number): number => {
    if (raw === undefined) return fallback;
    if (!finite(raw) || raw <= 0) {
      errors.push({ path, message: `${path} must be a positive number (mm) when present.` });
      return fallback;
    }
    return raw;
  };
  const board: BoardSpec = {
    widthMm: finite(boardRaw.widthMm) && boardRaw.widthMm > 0 ? boardRaw.widthMm : 80,
    heightMm: finite(boardRaw.heightMm) && boardRaw.heightMm > 0 ? boardRaw.heightMm : 50,
    marginMm: finite(boardRaw.marginMm) && boardRaw.marginMm >= 0 ? boardRaw.marginMm : 5,
    layers: boardLayers,
    clearanceMm: positive('board.clearanceMm', boardRaw.clearanceMm, 0.2),
    trackWidthMm: positive('board.trackWidthMm', boardRaw.trackWidthMm, 0.25),
    viaDiameterMm: positive('board.viaDiameterMm', boardRaw.viaDiameterMm, 0.6),
    viaDrillMm: positive('board.viaDrillMm', boardRaw.viaDrillMm, 0.3),
    autoroute: boardRaw.autoroute !== false,
    routingAttempts: finite(boardRaw.routingAttempts) ? Math.max(1, Math.min(10, Math.trunc(boardRaw.routingAttempts))) : 3,
    gndPours: boardRaw.gndPours === true,
    groundNet: string(boardRaw.groundNet) ? boardRaw.groundNet : 'GND',
  };
  if (finite(boardRaw.viaDiameterMm) && finite(boardRaw.viaDrillMm) && boardRaw.viaDrillMm >= boardRaw.viaDiameterMm) {
    errors.push({ path: 'board.viaDrillMm', message: 'board.viaDrillMm must be smaller than board.viaDiameterMm.' });
  }

  // 0.4.0 routing spec: backend allow-list, positive numeric guards. The
  // board section stays the single source for track/via/clearance values.
  let routing: RoutingSpec | undefined;
  const routingRaw = boardRaw.routing;
  if (routingRaw !== undefined) {
    if (!obj(routingRaw)) {
      errors.push({ path: 'board.routing', message: 'board.routing must be an object when present.' });
    } else {
      const backend = routingRaw.backend === undefined ? 'freerouting' : routingRaw.backend;
      if (backend !== 'freerouting') {
        errors.push({ path: 'board.routing.backend', message: `Unsupported routing backend '${String(backend)}'. 0.4.0 ships 'freerouting' only.` });
      }
      const maxPasses = routingRaw.maxPasses === undefined ? 20 : routingRaw.maxPasses;
      if (!finite(maxPasses) || maxPasses < 1 || !Number.isInteger(maxPasses)) {
        errors.push({ path: 'board.routing.maxPasses', message: 'board.routing.maxPasses must be a positive integer when present.' });
      }
      const timeoutSeconds = routingRaw.timeoutSeconds === undefined ? 300 : routingRaw.timeoutSeconds;
      if (!finite(timeoutSeconds) || timeoutSeconds <= 0) {
        errors.push({ path: 'board.routing.timeoutSeconds', message: 'board.routing.timeoutSeconds must be a positive number when present.' });
      }
      routing = {
        backend: backend === 'freerouting' ? 'freerouting' : undefined,
        maxPasses: finite(maxPasses) ? Math.trunc(maxPasses) : undefined,
        timeoutSeconds: finite(timeoutSeconds) ? timeoutSeconds : undefined,
      };
    }
  }
  if (routing) board.routing = routing;

  // 0.4.0 explicit copper zones: every zone must name an existing net and a
  // non-empty layer. Unmatched zone nets are an error (intent pointing at a
  // net that does not exist can never be satisfied).
  const zonesRaw = Array.isArray(input.zones) ? input.zones : [];
  const zones: ZoneSpec[] = [];
  for (let i = 0; i < zonesRaw.length; i++) {
    const raw = zonesRaw[i];
    const p = `zones[${i}]`;
    if (!obj(raw)) {
      errors.push({ path: p, message: 'Zone must be an object.' });
      continue;
    }
    const net = string(raw.net) ? raw.net.trim() : '';
    const layer = string(raw.layer) ? raw.layer.trim() : '';
    if (!net) errors.push({ path: `${p}.net`, message: 'Zone net is required.' });
    else if (!netNames.has(net)) errors.push({ path: `${p}.net`, message: `Zone net '${net}' does not exist in nets.` });
    if (!layer) errors.push({ path: `${p}.layer`, message: 'Zone layer is required.' });
    const zClear = positive(`${p}.clearanceMm`, raw.clearanceMm, 0.2);
    const zMin = positive(`${p}.minWidthMm`, raw.minWidthMm, 0.2);
    const priority = raw.priority === undefined ? 0 : raw.priority;
    if (!finite(priority) || !Number.isInteger(priority) || priority < 0) {
      errors.push({ path: `${p}.priority`, message: 'Zone priority must be a non-negative integer when present.' });
    }
    const thermal = raw.thermal === 'solid' || raw.thermal === 'relief' ? raw.thermal : 'relief';
    zones.push({
      net,
      layer,
      clearanceMm: zClear,
      minWidthMm: zMin,
      fill: raw.fill === 'hatched' ? 'hatched' : 'solid',
      priority: finite(priority) ? Math.trunc(priority) : 0,
      thermal,
    });
  }

  const netclassesRaw = Array.isArray(input.netclasses) ? input.netclasses : [];
  const netclasses: NetclassRule[] = [];
  for (let i = 0; i < netclassesRaw.length; i++) {
    const raw = netclassesRaw[i];
    const p = `netclasses[${i}]`;
    if (!obj(raw) || !string(raw.name) || !finite(raw.trackWidthMm) || !finite(raw.clearanceMm)) {
      errors.push({ path: p, message: 'Netclass requires name, trackWidthMm and clearanceMm.' });
      continue;
    }
    netclasses.push({
      name: raw.name,
      trackWidthMm: raw.trackWidthMm,
      clearanceMm: raw.clearanceMm,
      viaDiameterMm: finite(raw.viaDiameterMm) ? raw.viaDiameterMm : undefined,
      viaDrillMm: finite(raw.viaDrillMm) ? raw.viaDrillMm : undefined,
      nets: Array.isArray(raw.nets) ? raw.nets.filter(string) : undefined,
    });
  }

  if (profile === 'automotive') {
    if (!components.some((c) => /TVS/i.test(c.value ?? '') || /TVS/i.test(c.symbol))) {
      warnings.push({ path: 'components', message: 'Automotive profile: no obvious TVS component was found.' });
    }
    if (!nets.some((n) => /GND|GROUND/i.test(n.name))) {
      warnings.push({ path: 'nets', message: 'Automotive profile: no obvious ground net was found.' });
    }
  }

  if (errors.length) return { ok: false, errors, warnings };

  const design: CircuitIR = {
    version: IR_VERSION,
    project: {
      name: projectName,
      description: string(projectRaw.description) ? projectRaw.description : undefined,
      profile,
    },
    blocks,
    components,
    nets,
    netclasses: netclasses.length ? netclasses : undefined,
    board,
    zones: zones.length ? zones : undefined,
    manufacturing: obj(input.manufacturing)
      ? {
          enabled: input.manufacturing.enabled !== false,
          outputDir: string(input.manufacturing.outputDir) ? input.manufacturing.outputDir : 'manufacturing',
          gerberZip: input.manufacturing.gerberZip !== false,
          bom: input.manufacturing.bom !== false,
          cpl: input.manufacturing.cpl !== false,
        }
      : { enabled: true, outputDir: 'manufacturing', gerberZip: true, bom: true, cpl: true },
  };
  return { ok: true, errors, warnings, design };
}

export function defaultNetclasses(profile: ProjectProfile = 'generic'): NetclassRule[] {
  if (profile === 'automotive') {
    return [
      { name: 'Power_12V', trackWidthMm: 0.8, clearanceMm: 0.25, viaDiameterMm: 0.8, viaDrillMm: 0.4 },
      { name: 'Power_5V', trackWidthMm: 0.6, clearanceMm: 0.2, viaDiameterMm: 0.7, viaDrillMm: 0.35 },
      { name: 'Sensor_Signal', trackWidthMm: 0.4, clearanceMm: 0.2, viaDiameterMm: 0.6, viaDrillMm: 0.3 },
      { name: 'Logic_Default', trackWidthMm: 0.25, clearanceMm: 0.2, viaDiameterMm: 0.6, viaDrillMm: 0.3 },
    ];
  }
  return [
    { name: 'Default', trackWidthMm: 0.25, clearanceMm: 0.2, viaDiameterMm: 0.6, viaDrillMm: 0.3 },
  ];
}
