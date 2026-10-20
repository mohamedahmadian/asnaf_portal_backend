import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
loadEnv({ path: path.join(projectRoot, '.env') });

const destination = path.join(projectRoot, 'prisma', 'schema.prisma');
const explicitSource = process.env.ASNAF_PRISMA_SCHEMA_SOURCE?.trim();

async function readableFile(file) {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function looksLikeSchema(file) {
  const header = await readFile(file, { encoding: 'utf8' });
  return (
    header.includes('generator client') && header.includes('datasource db')
  );
}

if (explicitSource) {
  const source = path.resolve(explicitSource);
  if (!(await readableFile(source))) {
    throw new Error(`ASNAF_PRISMA_SCHEMA_SOURCE is not readable: ${source}`);
  }
  if (!(await looksLikeSchema(source))) {
    throw new Error(
      `ASNAF_PRISMA_SCHEMA_SOURCE does not look like a Prisma schema: ${source}`,
    );
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  console.log(`Prisma schema snapshot copied from ${source}`);
  process.exit(0);
}

if (await readableFile(destination) && (await looksLikeSchema(destination))) {
  console.log(
    'Using prisma/schema.prisma in this project. Set ASNAF_PRISMA_SCHEMA_SOURCE only to copy from an explicit file.',
  );
  process.exit(0);
}

throw new Error(
  'prisma/schema.prisma is missing. Commit the portal schema snapshot or set ASNAF_PRISMA_SCHEMA_SOURCE to an explicit file.',
);
