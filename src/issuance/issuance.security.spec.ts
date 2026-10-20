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

const identityUser = {
  firstName: 'علی',
  lastName: 'رضایی',
  fullName: 'علی رضایی',
  fatherName: null,
  lastNameEn: null,
  nationalId: '0012345678',
  gender: 'MALE',
  religion: null,
  religionOther: null,
  birthDate: null,
  birthPlace: null,
  identityCertificateNo: null,
  identityIssuedIn: null,
  country: null,
  residencyStatus: null,
  passportNumber: null,
  nationalCardExpiresAt: null,
  passportExpiresAt: null,
  phone: '09120000000',
  homePhone: null,
  email: null,
  address: null,
  postalCode: null,
  educationLevel: null,
  citizenGroup: null,
  economicJob: null,
};

describe('portal issuance ownership and lock', () => {
  it('does not create a case when opening the formation draft', async () => {
    const caseCreate = jest.fn();
    const service = makeService({
      caseFile: { findFirst: jest.fn().mockResolvedValue(null), create: caseCreate },
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue(identityUser) },
      personDocument: { findMany: jest.fn().mockResolvedValue([]) },
    });

    const result = await service.draft('user-a');

    expect(caseCreate).not.toHaveBeenCalled();
    expect(result.case.id).toBe('');
    expect(result.editable).toBe(true);
    expect(result.identity.nationalId).toBe('0012345678');
  });

  it('creates the case only when identity continue is confirmed', async () => {
    const caseCreate = jest.fn().mockResolvedValue({ id: 'case-new' });
    const service = makeService({
      caseFile: {
        findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValue({
          id: 'case-new',
          kind: 'LICENSE',
          formationStep: 1,
        }),
        create: caseCreate,
      },
      caseRequest: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue({
          id: 'request-new',
          number: 'REQ-1',
          status: 'OPEN',
          formationStep: 1,
          createdAt: new Date(),
        }),
      },
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(identityUser),
      },
      personDocument: { findMany: jest.fn().mockResolvedValue([]) },
      caseActivityDocument: { findMany: jest.fn().mockResolvedValue([]) },
    });

    await service.confirmDraft('user-a');

    expect(caseCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-a',
          formationStep: 1,
        }),
      }),
    );
  });

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

  it('locks applicant edits after the initial intake submission', async () => {
    const service = makeService({
      caseFile: {
        findFirst: jest.fn().mockResolvedValue({ ...lockedCase, formationStep: 2 }),
      },
      caseRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'request-a',
          number: 'REQ-1',
          status: 'OPEN',
          formationStep: 2,
          intakeSubmittedAt: new Date(),
          createdAt: new Date(),
        }),
      },
      job: { findFirst: jest.fn() },
    });

    await expect(
      service.saveLocation('user-a', 'case-a', {
        cityId: 'city-a',
        establishment: 'INDEPENDENT',
        address: 'نشانی تازه',
        ownership: 'OWNED',
        area: 12,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
