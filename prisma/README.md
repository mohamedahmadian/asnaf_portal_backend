# Prisma schema snapshot

`schema.prisma` is a read-only snapshot of the source schema at:

```text
../asnaf/backend/prisma/schema.prisma
```

The internal Asnaf backend remains the only source of truth for database
models and migrations. This portal project must never create, edit, deploy, or
reset migrations.

After the source schema changes, refresh and generate the portal client:

```bash
npm run prisma:schema:sync
npm run prisma:generate
```

Set `ASNAF_PRISMA_SCHEMA_SOURCE` to an absolute file path only when the
projects do not use the standard sibling layout. Review the resulting schema
diff before committing it.
