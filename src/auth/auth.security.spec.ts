import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import {
  AuthService,
  LoginController,
  PortalJwtStrategy,
} from './auth.module';

jest.mock('bcrypt', () => ({ compare: jest.fn(), hash: jest.fn() }));

const config = {
  getOrThrow: jest.fn((key: string) => {
    if (key === 'auth.secret') return 'test-secret-at-least-32-characters';
    if (key === 'auth.audience') return 'portal';
    if (key === 'auth.issuer') return 'portal-api';
    return '';
  }),
};

const actorUser = {
  id: 'actor-1',
  username: '0499370899',
  passwordHash: 'hash',
  fullName: 'فعال اقتصادی',
  nationalId: '0499370899',
  phone: '09120000000',
  photoId: null,
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

  it('keeps forgot-password and register public', () => {
    expect(
      Reflect.getMetadata(
        'portal:public',
        LoginController.prototype.forgotPassword,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata('portal:public', LoginController.prototype.register),
    ).toBe(true);
  });

  it('does not reset a password unless the account is an active economic actor', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const update = jest.fn();
    const service = new AuthService(
      { user: { findFirst, update } } as never,
      { signAsync: jest.fn() } as never,
      config as never,
    );

    await expect(
      service.forgotPassword({ identifier: '0012345678', channel: 'sms' }),
    ).resolves.toEqual({ status: 'not_found' });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ACTIVE',
          userRoles: { some: { role: { code: 'ECONOMIC_ACTOR' } } },
        }),
      }),
    );
    expect(update).not.toHaveBeenCalled();
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });

  it('does not change the password when email recovery is requested', async () => {
    const update = jest.fn();
    const service = new AuthService(
      {
        user: { findFirst: jest.fn().mockResolvedValue(actorUser), update },
      } as never,
      { signAsync: jest.fn() } as never,
      config as never,
    );

    await expect(
      service.forgotPassword({ identifier: actorUser.nationalId, channel: 'email' }),
    ).resolves.toEqual({ status: 'no_email' });
    expect(update).not.toHaveBeenCalled();
  });

  it('assigns only ECONOMIC_ACTOR when registering a new portal user', async () => {
    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed');
    const findFirst = jest.fn().mockResolvedValue(null);
    const upsert = jest.fn().mockResolvedValue({ id: 'role-actor' });
    const create = jest.fn().mockResolvedValue({
      ...actorUser,
      passwordHash: undefined,
    });
    const signAsync = jest.fn().mockResolvedValue('token');
    const service = new AuthService(
      {
        user: { findFirst, create },
        role: { upsert },
      } as never,
      { signAsync } as never,
      config as never,
    );

    await expect(
      service.register({
        firstName: 'علی',
        lastName: 'رضایی',
        nationalId: '0499370899',
        phone: '09120000000',
        password: 'secret123',
      }),
    ).resolves.toMatchObject({
      accessToken: 'token',
      user: expect.objectContaining({ nationalId: '0499370899' }),
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { code: 'ECONOMIC_ACTOR' },
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          username: '0499370899',
          nationalId: '0499370899',
          userRoles: { create: { roleId: 'role-actor' } },
        }),
      }),
    );
  });

  it('rejects registration when national id or phone already exists', async () => {
    const create = jest.fn();
    const service = new AuthService(
      {
        user: {
          findFirst: jest.fn().mockResolvedValue({
            nationalId: '0499370899',
            username: '0499370899',
            phone: '09121111111',
          }),
          create,
        },
      } as never,
      { signAsync: jest.fn() } as never,
      config as never,
    );

    await expect(
      service.register({
        firstName: 'علی',
        lastName: 'رضایی',
        nationalId: '0499370899',
        phone: '09120000000',
        password: 'secret123',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(create).not.toHaveBeenCalled();
  });
});
