const DEFAULT_PORT = 3001;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function port(): number {
  const raw = process.env.PORT?.trim();
  const value = raw ? Number(raw) : DEFAULT_PORT;
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return value;
}

function corsOrigins(): string[] {
  const origins = required('CORS_ORIGINS')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  if (origins.length === 0 || origins.includes('*')) {
    throw new Error('CORS_ORIGINS must contain explicit origins');
  }
  return origins;
}

export default () => ({
  app: {
    port: port(),
  },
  database: {
    url: required('DATABASE_URL'),
  },
  storage: {
    root: required('FILE_STORAGE_DIR'),
  },
  auth: {
    secret: required('PORTAL_JWT_SECRET'),
    audience: required('PORTAL_JWT_AUDIENCE'),
    issuer: required('PORTAL_JWT_ISSUER'),
  },
  cors: {
    origins: corsOrigins(),
  },
});
