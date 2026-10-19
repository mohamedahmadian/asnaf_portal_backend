import { NotFoundException } from '@nestjs/common';
import { AccountController, AccountService } from './account.module';
import type { PortalUser } from '../auth/auth.module';

const portalUser: PortalUser = {
  id: 'owner-user',
  username: 'owner',
  fullName: 'کاربر مالک',
  nationalId: null,
  phone: null,
  hasPhoto: true,
};

describe('portal account photo boundary', () => {
  it('keeps the owner photo route behind the portal auth guard', () => {
    expect(
      Reflect.getMetadata(
        'portal:public',
        AccountController.prototype.photo,
      ) as unknown,
    ).toBeUndefined();
  });

  it('loads the photo only through the authenticated owner id', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      photo: {
        data: Buffer.from('photo'),
        mimeType: 'image/jpeg',
        originalName: 'owner.jpg',
      },
    });
    const service = new AccountService({
      user: { findUnique },
    } as never);

    await expect(service.getPhoto('owner-user')).resolves.toMatchObject({
      mimeType: 'image/jpeg',
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'owner-user' },
      select: {
        photo: {
          select: {
            data: true,
            mimeType: true,
            originalName: true,
          },
        },
      },
    });
  });

  it('does not expose an arbitrary photo id through the controller', async () => {
    const photo = {
      data: Buffer.from('photo'),
      mimeType: 'image/jpeg',
      originalName: 'owner.jpg',
    };
    const getPhoto = jest.fn().mockResolvedValue(photo);
    const controller = new AccountController({ getPhoto } as never);
    const response = {
      setHeader: jest.fn(),
      send: jest.fn(),
    };

    await controller.photo(portalUser, response as never);

    expect(getPhoto).toHaveBeenCalledWith('owner-user');
    expect(response.send).toHaveBeenCalledWith(photo.data);
  });

  it('returns not found when the authenticated owner has no photo', async () => {
    const service = new AccountService({
      user: { findUnique: jest.fn().mockResolvedValue({ photo: null }) },
    } as never);

    await expect(service.getPhoto('owner-user')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('reports photo availability without exposing the stored image id', async () => {
    const service = new AccountService({
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'owner-user',
          username: 'owner',
          fullName: 'کاربر مالک',
          photoId: 'private-image-id',
        }),
      },
    } as never);

    const account = await service.get('owner-user');

    expect(account).toMatchObject({ hasPhoto: true });
    expect(account).not.toHaveProperty('photoId');
  });
});
