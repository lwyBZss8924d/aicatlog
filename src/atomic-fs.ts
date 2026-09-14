import { dlopen, FFIType, ptr, read, type Pointer } from 'bun:ffi';
import { AicatlogError } from './types.ts';

let native: { rename: (source: Pointer, target: Pointer) => number; errno: () => Pointer } | undefined;
/** Publish without overwriting a path created by another writer between checks. */
export function renameExclusive(source: string, target: string): void {
  if (source.includes('\0') || target.includes('\0')) throw new AicatlogError('INVALID_PATH', 'NUL is not a path character.');
  if (!native) {
    if (process.platform === 'darwin') {
      const library = dlopen('/usr/lib/libSystem.B.dylib', {
      renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
      });
      native = { rename: (a, b) => library.symbols.renamex_np(a, b, 4), errno: () => library.symbols.__error()! };
    } else if (process.platform === 'linux') {
      const library = dlopen('libc.so.6', {
      renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
      });
      native = { rename: (a, b) => library.symbols.renameat2(-100, a, -100, b, 1), errno: () => library.symbols.__errno_location()! };
    } else throw new AicatlogError('ATOMIC_RENAME_UNAVAILABLE', 'Source mutation needs the macOS/Linux exclusive rename backend.');
  }
  const from = Buffer.from(source + '\0'), to = Buffer.from(target + '\0');
  const result = native.rename(ptr(from), ptr(to));
  if (result !== 0) {
    const errno = read.i32(native.errno());
    throw new AicatlogError(errno === 17 ? 'TARGET_CHANGED' : errno === 18 ? 'STATE_FILESYSTEM_MISMATCH' : 'ATOMIC_RENAME_FAILED',
      errno === 18 ? 'Use a state directory on the same filesystem as the mutation targets.' : `Exclusive rename failed (${errno}).`, { source, target, errno });
  }
}
