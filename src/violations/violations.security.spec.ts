import { NotFoundException } from '@nestjs/common';
import { ViolationsService } from './violations.module';

function serviceWith(prisma: Record<string, unknown>) {
  return new ViolationsService(prisma as never);
}

describe('portal my-violations ownership', () => {
  it('lists only violations of the signed-in national id', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const service = serviceWith({
      user: { findUnique: jest.fn().mockResolvedValue({ nationalId: '0012345678' }) },
      violation: { findMany, count },
    });

    await service.list('user-a', { page: 1, pageSize: 10 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ nationalId: '0012345678' }),
      }),
    );
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ nationalId: '0012345678' }),
      }),
    );
  });

  it('returns an empty page when the user has no national id', async () => {
    const findMany = jest.fn();
    const service = serviceWith({
      user: { findUnique: jest.fn().mockResolvedValue({ nationalId: null }) },
      violation: { findMany },
    });

    await expect(service.list('user-a', { page: 1, pageSize: 10 })).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('returns 404 for another person violation', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      user: { findUnique: jest.fn().mockResolvedValue({ nationalId: '0012345678' }) },
      violation: { findFirst },
    });

    await expect(service.findOne('user-a', 'violation-b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'violation-b', nationalId: '0012345678' },
      }),
    );
  });

  it('returns 404 for another person attachment', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      user: { findUnique: jest.fn().mockResolvedValue({ nationalId: '0012345678' }) },
      violationAttachment: { findFirst },
    });

    await expect(
      service.attachment('user-a', 'violation-b', 'file-c'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'file-c',
          violationId: 'violation-b',
          violation: { nationalId: '0012345678' },
        },
      }),
    );
  });
});
