import { NotFoundException } from '@nestjs/common';
import { CasesService } from './cases.module';

function serviceWith(prisma: Record<string, unknown>) {
  const config = { getOrThrow: jest.fn().mockReturnValue('D:/storage') };
  return new CasesService(prisma as never, config as never);
}

describe('portal case ownership boundaries', () => {
  it('returns 404 for another owner case', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({ caseFile: { findFirst } });

    await expect(service.detail('user-a', 'case-b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'case-b', userId: 'user-a' } }),
    );
  });

  it('returns 404 for another owner dossier', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({ caseFile: { findFirst } });

    await expect(service.dossier('user-a', 'case-b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'case-b', userId: 'user-a' } }),
    );
  });

  it('returns 404 for another owner license', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({ caseFile: { findFirst } });

    await expect(service.license('user-a', 'case-b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'case-b', userId: 'user-a' } }),
    );
  });

  it('returns 404 for another owner request', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({ caseRequest: { findFirst } });

    await expect(service.request('user-a', 'request-b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'request-b', caseFile: { userId: 'user-a' } },
      }),
    );
  });

  it('returns 404 before reading another owner finance', async () => {
    const caseFindFirst = jest.fn().mockResolvedValue(null);
    const paymentFindMany = jest.fn();
    const requestFindMany = jest.fn();
    const service = serviceWith({
      caseFile: { findFirst: caseFindFirst },
      payment: { findMany: paymentFindMany },
      caseRequest: { findMany: requestFindMany },
    });

    await expect(service.finance('user-a', 'case-b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(paymentFindMany).not.toHaveBeenCalled();
    expect(requestFindMany).not.toHaveBeenCalled();
  });

  it('returns 404 for another owner document version', async () => {
    const personFindFirst = jest.fn().mockResolvedValue(null);
    const activityFindFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      personDocumentVersion: { findFirst: personFindFirst },
      caseActivityDocumentVersion: { findFirst: activityFindFirst },
    });

    await expect(
      service.document('user-a', 'version-b'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(personFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'version-b', personDocument: { userId: 'user-a' } },
      }),
    );
    expect(activityFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'version-b',
          caseActivityDocument: { caseFile: { userId: 'user-a' } },
        },
      }),
    );
  });

  it('returns 404 for another owner violations', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const findMany = jest.fn();
    const service = serviceWith({
      caseFile: { findFirst },
      violation: { findMany },
    });

    await expect(service.violations('user-a', 'case-b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it('returns 404 for another owner violation attachment', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const attachmentFindFirst = jest.fn();
    const service = serviceWith({
      caseFile: { findFirst },
      violationAttachment: { findFirst: attachmentFindFirst },
    });

    await expect(
      service.violationAttachment('user-a', 'case-b', 'violation-c', 'file-d'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(attachmentFindFirst).not.toHaveBeenCalled();
  });

  it('returns 404 for another owner suspension file', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({ caseSuspensionFile: { findFirst } });

    await expect(
      service.suspensionFile('user-a', 'case-b', 'file-c'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'file-c',
          suspension: { caseFileId: 'case-b', caseFile: { userId: 'user-a' } },
        },
      }),
    );
  });

  it('returns 404 before revoking another owner stewardship', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({ caseFile: { findFirst } });

    await expect(
      service.revokeStewardship('user-a', 'case-b', { reason: 'قطع همکاری' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'case-b',
          kind: 'STEWARDSHIP',
          OR: [{ userId: 'user-a' }, { hostCaseFile: { userId: 'user-a' } }],
        },
      }),
    );
  });

  it('applies host stewardship revoke immediately and stores the requester', async () => {
    const update = jest.fn();
    const service = serviceWith({
      caseFile: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'steward-1',
          userId: 'steward-user',
          status: 'ACTIVE',
          cardNumber: '1405-1',
          requests: [],
        }),
      },
      $transaction: async (fn: (tx: { caseFile: { update: typeof update } }) => Promise<unknown>) =>
        fn({ caseFile: { update } }),
    });

    const result = await service.revokeStewardship('host-user', 'steward-1', {
      reason: 'قطع همکاری',
      revokedAt: '2026-10-20',
    });

    expect(result).toEqual({
      id: 'steward-1',
      status: 'REVOKED',
      revokedAt: '2026-10-20',
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'steward-1' },
        data: expect.objectContaining({
          status: 'REVOKED',
          revokeSource: 'HOST',
          revokedById: 'host-user',
          revokeReason: 'قطع همکاری',
        }),
      }),
    );
    expect(update.mock.calls[0][0].data.revokeRequestedAt).toBeInstanceOf(Date);
  });
});
