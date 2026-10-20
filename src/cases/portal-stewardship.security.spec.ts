import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PortalStewardshipService } from './portal-stewardship.service';

function serviceWith(prisma: Record<string, unknown>) {
  return new PortalStewardshipService(prisma as never, { send: jest.fn() } as never);
}

describe('portal stewardship ownership', () => {
  it('returns 404 before listing stewards on another owner case', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      caseFile: { findFirst, findMany: jest.fn() },
    });

    await expect(service.list('user-a', 'case-b')).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'case-b', userId: 'user-a', kind: 'LICENSE' },
      }),
    );
  });

  it('returns 404 before looking up steward on another owner case', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      caseFile: { findFirst },
    });

    await expect(service.lookup('user-a', 'case-b', '0013542419')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'case-b', userId: 'user-a', kind: 'LICENSE' },
      }),
    );
  });

  it('returns 404 before creating steward on another owner case', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      caseFile: { findFirst },
    });

    await expect(service.create('user-a', 'case-b', '0013542419')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('blocks steward create without issued license', async () => {
    const service = serviceWith({
      caseFile: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'case-a',
          kind: 'LICENSE',
          status: 'ACTIVE',
          userId: 'user-a',
          licenseNumber: null,
          user: { nationalId: '1234567890' },
          suspensions: [],
        }),
      },
    });

    await expect(service.create('user-a', 'case-a', '0013542419')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects create when found steward has no phone', async () => {
    const service = serviceWith({
      caseFile: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'case-a',
          kind: 'LICENSE',
          status: 'ACTIVE',
          userId: 'user-a',
          licenseNumber: 'LIC-1',
          user: { nationalId: '1234567890' },
          suspensions: [],
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'steward-user',
          phone: null,
          nationalId: '0013542419',
        }),
      },
    });

    await expect(service.create('user-a', 'case-a', '0013542419')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('updates missing steward phone before creating the case', async () => {
    const update = jest.fn().mockResolvedValue({
      id: 'steward-user',
      phone: '09121111111',
      nationalId: '0013542419',
    });
    const createFile = jest.fn().mockResolvedValue({ id: 'file-1' });
    const createRequest = jest.fn().mockResolvedValue({ id: 'req-1' });
    const createEvent = jest.fn();
    const tx = {
      caseFile: { findFirst: jest.fn().mockResolvedValue(null), create: createFile },
      caseRequest: { create: createRequest },
      caseRequestEvent: { create: createEvent },
    };
    const service = serviceWith({
      caseFile: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'case-a',
            kind: 'LICENSE',
            status: 'ACTIVE',
            userId: 'user-a',
            licenseNumber: 'LIC-1',
            user: { nationalId: '1234567890' },
            suspensions: [],
          })
          .mockResolvedValueOnce(null),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'steward-user',
          phone: null,
          nationalId: '0013542419',
        }),
        findFirst: jest.fn().mockResolvedValue(null),
        update,
      },
      caseRequest: {
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    });

    await expect(
      service.create('user-a', 'case-a', '0013542419', '09121111111'),
    ).resolves.toEqual({ id: 'file-1' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'steward-user' },
        data: { phone: '09121111111' },
      }),
    );
  });

  it('returns 404 before cancelling steward on another owner case', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      caseFile: { findFirst },
    });

    await expect(service.cancelOpen('user-a', 'case-b', 'steward-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
