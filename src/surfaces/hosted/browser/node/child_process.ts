/** `node:child_process` for the browser bundle: there are no processes. */
function unavailable(): never {
  throw new Error("Processes are not available in the browser");
}
export const spawn = unavailable;
export const spawnSync = unavailable;
export const exec = unavailable;
export const execSync = unavailable;
export const execFile = unavailable;
export const execFileSync = unavailable;
export default { spawn, spawnSync, exec, execSync, execFile, execFileSync };
