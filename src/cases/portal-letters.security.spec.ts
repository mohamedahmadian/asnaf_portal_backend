import { NotFoundException } from '@nestjs/common';
import { CaseRequestType } from '../generated/prisma/client';
import { PortalLettersService } from './portal-letters.service';

function serviceWith(prisma: Record<string, unknown>) {
  return new PortalLettersService(prisma as never);
}

describe('portal letter ownership', () => {
  it('returns 404 for another owner inquiry letter', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      caseInquiry: { findFirst },
    });

    await expect(
      service.inquiryLetter('user-a', 'case-b', 'inquiry-c', CaseRequestType.ISSUANCE),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'inquiry-c',
          caseFileId: 'case-b',
          caseFile: { userId: 'user-a' },
        }),
      }),
    );
  });

  it('returns 404 for another owner places letter', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      casePlacesReview: { findFirst },
    });

    await expect(service.placesLetter('user-a', 'case-b', CaseRequestType.RENEWAL, 'request-c')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          caseFileId: 'case-b',
          caseFile: { userId: 'user-a' },
          caseRequestId: 'request-c',
        }),
      }),
    );
  });
});
