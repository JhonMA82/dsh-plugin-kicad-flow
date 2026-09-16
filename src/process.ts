import { execFile } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`${cmd} ${args.join(' ')} failed: ${err.message}\n${stderr}`) as Error & {
          stdout?: string;
          stderr?: string;
          code?: string | number;
        };
        e.stdout = stdout;
        e.stderr = stderr;
        e.code = (err as any).code;
        reject(e);
      } else resolve({ stdout, stderr });
    });
  });
}

export async function commandAvailable(command: string): Promise<boolean> {
  try {
    await run('sh', ['-lc', `command -v ${JSON.stringify(command)} >/dev/null 2>&1`]);
    return true;
  } catch {
    return false;
  }
}
