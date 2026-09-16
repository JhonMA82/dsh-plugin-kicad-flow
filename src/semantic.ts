/** Detect MCP tools that encode partial failure only in human-readable text.
 * Several KiCAD-MCP-Server batch wrappers return a normal MCP response even
 * when the Python backend reports per-item errors. The compiler must treat
 * those summaries as hard failures or it will continue into misleading
 * downstream errors (e.g. 0 labels placed after 0 components were added).
 */
export function semanticToolFailure(name: string, text: string): string | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;

  if (name === 'batch_add_components') {
    const m = normalized.match(/Added\s+(\d+)\s+component\(s\),\s+(\d+)\s+error\(s\)/i);
    if (m && Number(m[2]) > 0) return normalized;
  }

  if (name === 'batch_connect') {
    const m = normalized.match(/Placed\s+(\d+)\s+label\(s\),\s+(\d+)\s+failed/i);
    if (m && Number(m[2]) > 0) return normalized;
    // 0.2.6: the compiler never sends an empty connection batch, so a batch
    // that places nothing and reports nothing failed is a silent skip (the
    // vcm-controller power-rail failure mode). Fail loudly instead.
    if (m && Number(m[1]) === 0) return `batch_connect placed 0 labels: ${normalized}`;
  }

  if (name === 'batch_edit_schematic_components') {
    const m = normalized.match(/Updated\s+(\d+)\s*,\s*(\d+)\s+error\(s\)/i);
    if (m && Number(m[2]) > 0) return normalized;
  }

  if (name === 'batch_list_symbol_pins') {
    if (/^Errors:\s*$/im.test(normalized) || /\nErrors:\s*\n/i.test(normalized)) return normalized;
    if (/Failed to list pins:/i.test(normalized)) return normalized;
  }

  return undefined;
}
