import { NotFoundException } from '@nestjs/common';
import { SmsService } from './sms.service';

function serviceWith(prisma: Record<string, unknown>) {
  return new SmsService(prisma as never);
}

describe('portal my-sms ownership', () => {
  it('lists only messages sent to the signed-in phone', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const service = serviceWith({
      user: { findUnique: jest.fn().mockResolvedValue({ phone: '09123456789' }) },
      smsMessage: { findMany, count },
    });

    await service.listMine('user-a', { page: 1, pageSize: 10 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone: { in: expect.arrayContaining(['09123456789', '9123456789']) },
        }),
      }),
    );
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone: { in: expect.arrayContaining(['09123456789']) },
        }),
      }),
    );
  });

  it('returns an empty page when the user has no phone', async () => {
    const findMany = jest.fn();
    const service = serviceWith({
      user: { findUnique: jest.fn().mockResolvedValue({ phone: null }) },
      smsMessage: { findMany },
    });

    await expect(
      service.listMine('user-a', { page: 1, pageSize: 10 }),
    ).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('returns 404 for a message sent to another number', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      user: { findUnique: jest.fn().mockResolvedValue({ phone: '09123456789' }) },
      smsMessage: { findFirst },
    });

    await expect(service.findMine('user-a', 'sms-b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'sms-b',
          phone: { in: expect.arrayContaining(['09123456789']) },
        },
      }),
    );
  });
});
