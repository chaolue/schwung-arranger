/* QuickJS's `os` module, as much of it as ui.js touches at load and in init(). */
export const O_APPEND = 1024, O_CREAT = 64, O_TRUNC = 512, O_WRONLY = 1;
export function readdir() { return [[], 0]; }
export function stat() { return [null, -2]; }
export function open() { return -1; }
export function write() { return 0; }
export function close() { return 0; }
export function remove() { return 0; }
