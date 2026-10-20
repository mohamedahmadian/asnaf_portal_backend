import { NotFoundException } from '@nestjs/common';
import { access, readFile, unlink } from 'node:fs/promises';
import * as path from 'node:path';

function storageRoot(primary: string): string {
  return path.resolve(primary);
}

function safeAbsolute(root: string, storageKey: string): string | null {
  const absolute = path.resolve(root, storageKey);
  if (!absolute.startsWith(`${root}${path.sep}`)) return null;
  return absolute;
}

export async function readStoredBytes(storageKey: string, primaryRoot: string) {
  const absolute = safeAbsolute(storageRoot(primaryRoot), storageKey);
  if (!absolute) throw new NotFoundException('پیوست یافت نشد');
  try {
    return await readFile(absolute);
  } catch {
    throw new NotFoundException('پیوست یافت نشد');
  }
}

export async function resolveStoredAbsolute(
  storageKey: string,
  primaryRoot: string,
  missingMessage = 'فایل یافت نشد',
) {
  const absolute = safeAbsolute(storageRoot(primaryRoot), storageKey);
  if (!absolute) throw new NotFoundException(missingMessage);
  try {
    await access(absolute);
    return absolute;
  } catch {
    throw new NotFoundException(missingMessage);
  }
}

export async function removeStoredKeys(keys: string[], primaryRoot: string) {
  const root = storageRoot(primaryRoot);
  await Promise.all(
    keys.map(async (key) => {
      const absolute = safeAbsolute(root, key);
      if (!absolute) return;
      await unlink(absolute).catch(() => undefined);
    }),
  );
}
