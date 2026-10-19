import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.FILE_STORAGE_DIR = 'test-storage';
    process.env.PORTAL_JWT_SECRET = 'test-secret-with-at-least-32-characters';
    process.env.PORTAL_JWT_AUDIENCE = 'test-portal';
    process.env.PORTAL_JWT_ISSUER = 'test-api';
    process.env.CORS_ORIGINS = 'http://localhost:5174';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/user/v1');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/api/user/v1/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/user/v1/health')
      .expect(200)
      .expect({
        service: 'asnaf-portal-backend',
        status: 'ok',
      });
  });
});
