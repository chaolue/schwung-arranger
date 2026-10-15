/* QuickJS's `os` module, as much of it as ui.js touches at load and in init(). */
export const O_APPEND = 1024, O_CREAT = 64, O_TRUNC = 512, O_WRONLY = 1;
import { files } from './host_mock.mjs';
export function readdir(dir) {
    const prefix = dir.endsWith("/") ? dir : dir + "/";
    const names = new Set();
    for (const path of files.keys()) {
        if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split("/")[0]);
    }
    return [[...names], 0];
}
export function stat() { return [null, -2]; }
/* Binary writes (os.open/os.write) fail unless a suite opts in with
 * captureWrites(true); then each file's bytes land in `written`. */
export const written = new Map();
let capture = false;
const fds = new Map();
export function captureWrites(on) { capture = on; }
export function open(path) {
    if (!capture) return -1;
    const fd = 100 + fds.size;
    fds.set(fd, path);
    written.set(path, []);
    return fd;
}
export function write(fd, buffer, offset, length) {
    const path = fds.get(fd);
    if (!path) return 0;
    const bytes = new Uint8Array(buffer, offset, length);
    written.get(path).push(...bytes);
    return length;
}
export function close(fd) { fds.delete(fd); return 0; }
export function remove() { return 0; }
