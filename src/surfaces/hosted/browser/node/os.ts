/** `node:os` for the browser bundle: a fixed, empty machine. */
export const EOL = "\n";
export const homedir = () => "/nq-home";
export const tmpdir = () => "/tmp";
export const platform = () => "linux";
export const arch = () => "wasm";
export const hostname = () => "browser";
export const cpus = () => [];
export const totalmem = () => 0;
export const networkInterfaces = () => ({});
export default { EOL, homedir, tmpdir, platform, arch, hostname, cpus, totalmem, networkInterfaces };
