import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PortalAuctionService } from './portal-auction.service';

function serviceWith(prisma: Record<string, unknown>) {
  return new PortalAuctionService(prisma as never, { getOrThrow: jest.fn().mockReturnValue('D:/storage') } as never);
}

const dto = {
  title: 'مجوز حراج',
  startsAt: '2026-10-21',
  endsAt: '2026-10-25',
  discountMin: 10,
  discountMax: 30,
  items: [{ name: 'کالا', price: 1000, discountPercent: 20 }],
};

describe('portal auction ownership and lock', () => {
  it('returns 404 for another owner auction', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const findUnique = jest.fn();
    const service = serviceWith({
      caseFile: { findFirst },
      caseAuction: { findUnique },
    });

    await expect(service.find('user-a', 'case-b', 'request-c')).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'case-b', userId: 'user-a', kind: 'LICENSE' } }),
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns 404 before creating auction on another owner case', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const transaction = jest.fn();
    const service = serviceWith({
      caseFile: { findFirst },
      $transaction: transaction,
    });

    await expect(service.create('user-a', 'case-b', dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('blocks auction without an issued license', async () => {
    const service = serviceWith({
      caseFile: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'case-a',
          userId: 'user-a',
          status: 'ACTIVE',
          licenseNumber: null,
          kind: 'LICENSE',
        }),
      },
    });

    await expect(service.create('user-a', 'case-a', dto)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 before updating another owner auction', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const transaction = jest.fn();
    const service = serviceWith({
      caseFile: { findFirst },
      $transaction: transaction,
    });

    await expect(service.update('user-a', 'case-b', 'request-c', dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('returns 404 before reading another owner review file', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      caseManagementReviewFile: { findFirst },
    });

    await expect(
      service.reviewFile('user-a', 'case-b', 'request-c', 'review-d', 'file-e'),
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
            caseRequest: { type: 'AUCTION' },
          },
        },
      }),
    );
  });
});
