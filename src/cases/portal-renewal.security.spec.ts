import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PortalRenewalService } from './portal-renewal.service';

function serviceWith(prisma: Record<string, unknown>) {
  return new PortalRenewalService(
    prisma as never,
    { getOrThrow: jest.fn().mockReturnValue('D:/storage') } as never,
  );
}

describe('portal renewal ownership and lock', () => {
  it('returns 404 for another owner renewal', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      caseFile: { findFirst },
      caseRequest: { findFirst },
    });

    await expect(service.find('user-a', 'case-b', 'request-c')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'case-b', userId: 'user-a', kind: 'LICENSE' },
      }),
    );
  });

  it('returns 404 before creating renewal on another owner case', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const transaction = jest.fn();
    const service = serviceWith({
      caseFile: { findFirst },
      $transaction: transaction,
    });

    await expect(service.create('user-a', 'case-b')).rejects.toBeInstanceOf(NotFoundException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('blocks renewal without an issued license', async () => {
    const service = serviceWith({
      caseFile: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'case-a',
          userId: 'user-a',
          status: 'ACTIVE',
          licenseNumber: null,
          licenseIssuedAt: null,
          licenseExpiresAt: null,
          kind: 'LICENSE',
        }),
      },
    });

    await expect(service.create('user-a', 'case-a')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks renewal on a revoked case', async () => {
    const service = serviceWith({
      caseFile: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'case-a',
          userId: 'user-a',
          status: 'REVOKED',
          licenseNumber: '1405-0001',
          licenseIssuedAt: new Date('2026-01-01'),
          licenseExpiresAt: new Date('2027-01-01'),
          kind: 'LICENSE',
        }),
      },
    });

    await expect(service.create('user-a', 'case-a')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 before uploading to another owner renewal', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      caseRequest: { findFirst },
    });

    await expect(
      service.upload('user-a', 'case-b', 'request-c', { documentId: 'doc-1' }, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'request-c',
          caseFileId: 'case-b',
          type: 'RENEWAL',
          caseFile: { userId: 'user-a' },
        },
      }),
    );
  });

  it('returns 404 before reading another owner review file', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      caseManagementReviewFile: { findFirst },
    });

    await expect(
      service.managementFile('user-a', 'case-b', 'request-c', 'review-d', 'file-e'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'file-e',
          reviewId: 'review-d',
          review: {
            id: 'review-d',
            caseFileId: 'case-b',
            caseRequestId: 'request-c',
            caseFile: { userId: 'user-a' },
            caseRequest: { type: 'RENEWAL' },
          },
        },
      }),
    );
  });
});
