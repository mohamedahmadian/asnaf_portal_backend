import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService, PortalJwtStrategy } from './auth.module';

jest.mock('bcrypt', () => ({ compare: jest.fn(), hash: jest.fn() }));

const config = {
  getOrThrow: jest.fn((key: string) => {
    if (key === 'auth.secret') return 'test-secret-at-least-32-characters';
    if (key === 'auth.audience') return 'portal';
    if (key === 'auth.issuer') return 'portal-api';
    return '';
  }),
};

describe('portal authentication boundary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not authenticate a user without ECONOMIC_ACTOR role', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const jwt = { signAsync: jest.fn() };
    const service = new AuthService(
      { user: { findFirst } } as never,
      jwt as never,
      config as never,
    );

    await expect(
      service.login({ identifier: '0012345678', password: 'secret' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ACTIVE',
          userRoles: { some: { role: { code: 'ECONOMIC_ACTOR' } } },
        }),
      }),
    );
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it('rechecks active role membership on every JWT request', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const strategy = new PortalJwtStrategy(
      config as never,
      { user: { findFirst } } as never,
    );

    await expect(
      strategy.validate({ sub: 'disabled-user', typ: 'portal-access' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'disabled-user',
          status: 'ACTIVE',
          userRoles: { some: { role: { code: 'ECONOMIC_ACTOR' } } },
        },
      }),
    );
  });

  it('rejects tokens not issued as portal access tokens', async () => {
    const strategy = new PortalJwtStrategy(
      config as never,
      { user: { findFirst: jest.fn() } } as never,
    );
    await expect(
      strategy.validate({ sub: 'user-a', typ: 'admin-access' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
