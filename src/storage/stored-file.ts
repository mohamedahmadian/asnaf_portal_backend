import { NotFoundException } from '@nestjs/common';
import { access, readFile, unlink } from 'node:fs/promises';
import * as path from 'node:path';

function storageRoots(primary: string): string[] {
  const roots = [path.resolve(primary)];
  const sibling = path.resolve(process.cwd(), '..', 'backend', 'storage');
  if (sibling !== roots[0]) roots.push(sibling);
  return roots;
}

function safeAbsolute(root: string, storageKey: string): string | null {
  const absolute = path.resolve(root, storageKey);
  if (!absolute.startsWith(`${root}${path.sep}`)) return null;
  return absolute;
}

export async function readStoredBytes(storageKey: string, primaryRoot: string) {
  for (const root of storageRoots(primaryRoot)) {
    const absolute = safeAbsolute(root, storageKey);
    if (!absolute) continue;
    try {
      return await readFile(absolute);
    } catch {
      continue;
    }
  }
  throw new NotFoundException('پیوست یافت نشد');
}

export async function resolveStoredAbsolute(
  storageKey: string,
  primaryRoot: string,
  missingMessage = 'فایل یافت نشد',
) {
  for (const root of storageRoots(primaryRoot)) {
    const absolute = safeAbsolute(root, storageKey);
    if (!absolute) continue;
    try {
      await access(absolute);
      return absolute;
    } catch {
      continue;
    }
  }
  throw new NotFoundException(missingMessage);
}

export async function removeStoredKeys(keys: string[], primaryRoot: string) {
  await Promise.all(
    keys.map(async (key) => {
      await Promise.all(
        storageRoots(primaryRoot).map(async (root) => {
          const absolute = safeAbsolute(root, key);
          if (!absolute) return;
          await unlink(absolute).catch(() => undefined);
        }),
      );
    }),
  );
}
