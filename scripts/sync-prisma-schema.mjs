import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const defaultSource = path.resolve(
  projectRoot,
  '..',
  'backend',
  'prisma',
  'schema.prisma',
);
const source = path.resolve(
  process.env.ASNAF_PRISMA_SCHEMA_SOURCE ?? defaultSource,
);
const destination = path.join(projectRoot, 'prisma', 'schema.prisma');

const sourceHeader = await readFile(source, { encoding: 'utf8' });
if (
  !sourceHeader.includes('generator client') ||
  !sourceHeader.includes('datasource db')
) {
  throw new Error(
    `Source does not look like an Asnaf Prisma schema: ${source}`,
  );
}

await mkdir(path.dirname(destination), { recursive: true });
await copyFile(source, destination);

console.log(`Prisma schema snapshot synced from ${source}`);
