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
export function open() { return -1; }
export function write() { return 0; }
export function close() { return 0; }
export function remove() { return 0; }
