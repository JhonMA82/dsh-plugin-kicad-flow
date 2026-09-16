// The runtime packages are normal npm dependencies. ts-ignore keeps this source
// buildable in minimal/offline CI containers where those packages are absent.
// @ts-ignore
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// @ts-ignore
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { semanticToolFailure } from './semantic.js';

export interface McpBridgeOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  callTimeoutMs?: number;
}

export interface RemoteToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  raw: unknown;
  text: string;
  json?: unknown;
  isError: boolean;
}

function extractText(res: any): string {
  const chunks = Array.isArray(res?.content) ? res.content : [];
  return chunks
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('\n');
}

function parseMaybeJson(text: string): unknown | undefined {
  const t = text.trim();
  if (!t) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}



export class McpBridge {
  private client?: any;
  private transport?: any;
  private tools = new Map<string, RemoteToolInfo>();

  constructor(private readonly opts: McpBridgeOptions) {}

  async start(): Promise<RemoteToolInfo[]> {
    if (this.client) return this.listRemoteTools();
    const env = { ...process.env, ...this.opts.env } as Record<string, string>;
    this.transport = new StdioClientTransport({ command: this.opts.command, args: this.opts.args ?? [], env });
    this.client = new Client({ name: 'dsh-plugin-kicad-flow', version: '0.3.0' });
    await this.client.connect(this.transport);
    const result = await this.client.listTools();
    this.tools.clear();
    for (const tool of result.tools ?? []) {
      this.tools.set(tool.name, {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
      });
    }
    return this.listRemoteTools();
  }

  async ensureStarted(): Promise<void> {
    if (!this.client) await this.start();
  }

  listRemoteTools(): RemoteToolInfo[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  schema(name: string): Record<string, unknown> | undefined {
    return this.tools.get(name)?.inputSchema;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    await this.ensureStarted();
    if (!this.hasTool(name)) throw new Error(`KiCad MCP tool '${name}' is not available in the connected server.`);
    // NOTE (0.2.6 transport fix): @modelcontextprotocol/sdk >= 1.30 signs
    // callTool as (params, resultSchema?, options?). The timeout object must
    // be the THIRD argument; passing it second makes protocol.js validate
    // every response against a plain object and crash with
    // "v3Schema.safeParse is not a function". `undefined` selects the
    // default CallToolResultSchema.
    const raw = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: this.opts.callTimeoutMs ?? 660_000 },
    );
    const text = extractText(raw);
    const json = parseMaybeJson(text);
    const semanticFailure = semanticToolFailure(name, text);
    const isError = Boolean((raw as any)?.isError) || /^\s*(failed|error)\s*:/i.test(text) || Boolean(semanticFailure);
    const result = { raw, text, json, isError };
    if (isError) throw new Error(`KiCad MCP ${name} failed: ${semanticFailure || text || JSON.stringify(raw)}`);
    return result;
  }

  async callIfAvailable(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult | undefined> {
    await this.ensureStarted();
    return this.hasTool(name) ? this.call(name, args) : undefined;
  }

  async stop(): Promise<void> {
    try { await this.client?.close(); }
    finally {
      this.client = undefined;
      this.transport = undefined;
      this.tools.clear();
    }
  }
}
