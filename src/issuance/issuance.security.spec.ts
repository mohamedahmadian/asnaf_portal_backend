import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IssuanceService } from './issuance.module';

function makeService(prisma: Record<string, unknown>) {
  return new IssuanceService(
    prisma as never,
    { getOrThrow: jest.fn().mockReturnValue('D:/storage') } as never,
  );
}

const lockedCase = {
  id: 'case-a',
  formationStep: 3,
  trackingCode: 'CASE-1',
  businessUnitTitle: 'واحد',
  activityJobId: 'job-a',
  previousOccupation: null,
  posDeviceCount: null,
  premiseCityId: 'city-a',
  premiseEstablishment: 'INDEPENDENT',
  premiseComplexId: null,
  premiseAddress: 'نشانی',
  premisePlaque: null,
  premiseFloor: null,
  premiseUnitNo: null,
  premisePostalCode: null,
  premisePhone: null,
  premiseGeoPosition: null,
  premisePublicAccess: null,
  registrationPlaceId: null,
  premiseOwnership: 'OWNED',
  premiseDeedNo: null,
  premiseArea: 10,
  leaseIssuedAt: null,
  leaseExpiresAt: null,
  leaseAgency: null,
  premiseOwnerName: null,
};

describe('portal issuance ownership and lock', () => {
  it('returns 404 when editing another owner case', async () => {
    const service = makeService({
      caseFile: { findFirst: jest.fn().mockResolvedValue(null) },
    });

    await expect(
      service.saveActivity('user-a', 'case-b', {
        businessUnitTitle: 'واحد',
        jobId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('locks all applicant edits after final submission', async () => {
    const caseFindFirst = jest.fn().mockResolvedValue(lockedCase);
    const requestFindFirst = jest.fn().mockResolvedValue({
      id: 'request-a',
      number: 'REQ-1',
      status: 'OPEN',
      formationStep: 3,
      createdAt: new Date(),
    });
    const jobFindFirst = jest.fn();
    const service = makeService({
      caseFile: { findFirst: caseFindFirst },
      caseRequest: { findFirst: requestFindFirst },
      job: { findFirst: jobFindFirst },
    });

    await expect(
      service.saveActivity('user-a', 'case-a', {
        businessUnitTitle: 'تغییر غیرمجاز',
        jobId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(jobFindFirst).not.toHaveBeenCalled();
  });
});
