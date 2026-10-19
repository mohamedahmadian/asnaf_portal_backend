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
});
