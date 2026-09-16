import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 0.4.1 generic preflights (field findings, vcm-controller):
 * 1. A footprint whose library was renamed upstream (Fuse_SMD → Fuse in
 *    KiCad 10) used to pass silently as `footprints_skipped`, stacking every
 *    footprint at (0,0) and failing much later with a misleading courtyard
 *    error. Existence must be verified against the real fp-lib-table chain
 *    BEFORE any mutation.
 * 2. Symbol pin numbers that do not match footprint pad names (Relay_SPDT
 *    pins A1/A2/11/12/14 vs G5V-1 pads 1,2,5,6,9,10) used to surface as a
 *    PCB reconciliation failure after the whole schematic was built. The
 *    pin↔pad pair must be verified while only the schematic exists. */

export type FootprintPreflightProblem =
  | 'lib_not_found'
  | 'module_not_found'
  | 'module_unreadable'
  | 'pad_missing';

export interface FootprintPreflightIssue {
  ref: string;
  footprint: string;
  problem: FootprintPreflightProblem;
  detail: string;
}

export interface FootprintLibs {
  /** Footprint library nick → resolved directory containing <nick>.pretty. */
  dirs: Map<string, string>;
  /** Sources consulted, for actionable error messages. */
  tables: string[];
}

const DEFAULT_FOOTPRINT_ROOTS = [
  '/usr/share/kicad/footprints',
  '/usr/local/share/kicad/footprints',
];

/** Parse `(lib (name "Nick") (type "T") (uri "U"))` entries. */
export function parseFpLibTable(text: string): Array<{ name: string; type: string; uri: string }> {
  const out: Array<{ name: string; type: string; uri: string }> = [];
  const re = /\(lib\s*\(name\s+"([^"]*)"\)\s*\(type\s+"([^"]*)"\)\s*\(uri\s+"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const type = m[2];
    const uri = m[3];
    if (name === undefined || type === undefined || uri === undefined) continue;
    out.push({ name, type, uri });
  }
  return out;
}

async function listKicadConfigDirs(env: NodeJS.ProcessEnv): Promise<string[]> {
  const roots = [env.KICAD_CONFIG_HOME, join(homedir(), '.config', 'kicad')].filter((r): r is string => !!r);
  const dirs: string[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true }).then((es) => es.map((e) => e.name));
    } catch {
      // Root itself unreadable: still allow a fp-lib-table file directly at
      // the root (the root then acts as the version directory).
      try {
        await fs.access(join(root, 'fp-lib-table'));
      } catch {
        continue;
      }
      dirs.push(root);
    }
    for (const e of entries) dirs.push(join(root, e));
    // The root itself may be a version directory (single-version override via
    // KICAD_CONFIG_HOME pointing straight at a config version).
    try {
      await fs.access(join(root, 'fp-lib-table'));
      dirs.push(root);
    } catch {
      // not a version dir itself; entries above already cover it
    }
  }
  // Highest version last: later tables override earlier nicks.
  return dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function expandUri(uri: string, env: NodeJS.ProcessEnv): string {
  return uri.replace(/\$\{([A-Za-z0-9_]+)\}/g, (whole, name) => env[name] ?? whole);
}

function isUnresolvedFootprintDirVar(uri: string): boolean {
  return /\$\{KICAD\d*_FOOTPRINT_DIR\}/.test(uri);
}

/** Resolve the KiCad footprint library table chain: user config tables
 * (highest version wins) plus the global template table they may nest via
 * `(type "Table")`. Unresolved `${KICADn_FOOTPRINT_DIR}` variables fall back
 * to probing the default system roots per-library. */
export async function resolveFootprintLibs(env: NodeJS.ProcessEnv = process.env): Promise<FootprintLibs> {
  const dirs = new Map<string, string>();
  const tables: string[] = [];
  const configDirs = await listKicadConfigDirs(env);
  const tablePaths = configDirs.map((d) => join(d, 'fp-lib-table'));
  tablePaths.push('/usr/share/kicad/template/fp-lib-table');
  for (const tablePath of tablePaths) {
    let text: string;
    try {
      text = await fs.readFile(tablePath, 'utf8');
    } catch {
      continue;
    }
    tables.push(tablePath);
    for (const lib of parseFpLibTable(text)) {
      if (!lib.name) continue;
      if (lib.type === 'Table') {
        // Nested table (e.g. KiCad's template fp-lib-table): inline its libs.
        let nested: string;
        try {
          nested = await fs.readFile(expandUri(lib.uri, env), 'utf8');
        } catch {
          continue;
        }
        tables.push(`${tablePath} → ${lib.uri}`);
        for (const sub of parseFpLibTable(nested)) {
          if (sub.name) dirs.set(sub.name, sub.uri);
        }
        continue;
      }
      dirs.set(lib.name, lib.uri);
    }
  }
  // Expand env vars once; keep unresolved KICADn_FOOTPRINT_DIR markers so the
  // per-library fallback probe can replace them with a root that actually
  // contains the requested library.
  for (const [nick, uri] of dirs) {
    dirs.set(nick, expandUri(uri, env));
  }
  return { dirs, tables };
}

/** Resolve `Nick:FootprintName` to the .kicad_mod path, or null when the
 * library nick is unknown. */
export async function resolveFootprintPath(
  footprint: string,
  libs: FootprintLibs,
): Promise<{ path: string | null; problem: 'lib_not_found' | 'module_not_found' }> {
  const sep = footprint.indexOf(':');
  if (sep <= 0) return { path: null, problem: 'lib_not_found' };
  const nick = footprint.slice(0, sep);
  const name = footprint.slice(sep + 1);
  let uri = libs.dirs.get(nick);
  if (isUnresolvedFootprintDirVar(uri ?? '')) {
    // Probe default roots: keep the root that actually hosts this library.
    // The uri already names the <nick>.pretty directory, so the candidate
    // itself is the access target.
    for (const root of DEFAULT_FOOTPRINT_ROOTS) {
      const candidate = uri!.replace(/\$\{KICAD\d*_FOOTPRINT_DIR\}/, root);
      try {
        await fs.access(candidate);
        uri = candidate;
        break;
      } catch {
        continue;
      }
    }
  }
  if (!uri) return { path: null, problem: 'lib_not_found' };
  const path = uri.endsWith('.pretty')
    ? join(uri, `${name}.kicad_mod`)
    : join(uri, `${nick}.pretty`, `${name}.kicad_mod`);
  return { path, problem: 'module_not_found' };
}

/** Electrical pad names of a .kicad_mod file (empty-name pads excluded). */
export async function parseFootprintPads(modulePath: string): Promise<Set<string>> {
  const text = await fs.readFile(modulePath, 'utf8');
  const pads = new Set<string>();
  const re = /\(pad\s+"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) pads.add(m[1]);
  }
  return pads;
}
