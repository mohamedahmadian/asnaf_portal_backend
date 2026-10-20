# Asnaf portal backend

Independent NestJS API for the public economic actor portal.

## Boundaries

- Every public endpoint is under `/api/user/v1`.
- The portal uses its own JWT secret, issuer, and audience.
- The database and file storage are shared with the internal Asnaf system.
- Connect as `asnaf_portal` (DML only). Do not use `postgres` or `asnaf_admin`.
- Create that role with `../backend/scripts/create-db-users.sh`.
- `../backend/prisma/schema.prisma` is the schema source of truth.
- This project does not own or run database migrations.

## Public contract

All routes below are prefixed with `/api/user/v1`. Except for `POST
/auth/login`, every route requires the portal JWT and revalidates that the
database user is active and still owns the `ECONOMIC_ACTOR` role.

- `auth/login`, `auth/me`
- `account`, `account/password`
- `cases`, `cases/:caseId`, `cases/:caseId/finance`
- `cases/requests/:requestId`, `cases/documents/:versionId/file`
- `issuance/:caseId/**` for the applicant-owned issuance workflow
- `lookups/**` for the safe, read-only issuance catalogs

Case, request, finance, and document selectors include the authenticated
owner in the database predicate. Cross-owner identifiers intentionally return
404. Organizational issuance stages are read-only; this API has no decision,
reset, impersonation, or administrative issuance endpoints.

## Setup

1. Copy `.env.example` to `.env` and supply local secrets and paths.
2. Set `DATABASE_URL` to the `asnaf_portal` role from
   `../backend/scripts/create-db-users.sh` (`npm run db:users` in `backend`).
3. Run `npm run prisma:schema:sync` after `../backend/prisma/schema.prisma`
   changes (or set `ASNAF_PRISMA_SCHEMA_SOURCE` to an explicit source).
4. Run `npm run prisma:generate`.
5. Run `npm run build` for a compile check.

The default API port is `3001`. Do not expose the health route as an
authentication bypass for later feature controllers; public/private route
policy will be added with portal authentication.
