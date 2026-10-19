import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { CurrentUser, PortalUser } from '../auth/auth.module';
import {
  CaseFileKind,
  CaseRequestStatus,
  CaseRequestType,
  PaymentStatus,
  PremiseEstablishment,
  PremiseGeoPosition,
  PremiseOwnership,
  PremisePublicAccess,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const CASE_SORTS = [
  'createdAt',
  'updatedAt',
  'status',
  'licenseNumber',
  'fullName',
  'nationalId',
  'job',
  'jobGroup',
  'jobType',
  'jobTitle',
  'businessUnitTitle',
  'formationStep',
] as const;

const listJobSelect = {
  id: true,
  title: true,
  group: { select: { id: true, title: true } },
  jobType: { select: { id: true, title: true } },
} satisfies Prisma.JobSelect;

const CASE_KINDS = [
  'ISSUANCE',
  'RENEWAL',
  'LOCATION_CHANGE',
  'AUCTION',
  'STEWARD_REQUEST',
  'STEWARD_CARD',
] as const;

const CASE_STATUSES = ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED'] as const;

function latinDigits(value: string) {
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  return value.replace(/[۰-۹٠-٩]/g, (char) => {
    const persianIndex = persian.indexOf(char);
    return String(persianIndex >= 0 ? persianIndex : arabic.indexOf(char));
  });
}

function dateOnly(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function decimalText(value: Prisma.Decimal | null) {
  return value == null ? null : value.toString();
}

type DossierPlaceRow = {
  premiseCityId: string | null;
  premiseEstablishment: PremiseEstablishment | null;
  premiseComplexId: string | null;
  premiseAddress: string | null;
  premiseAddressEn: string | null;
  premisePlaque: string | null;
  premisePlaqueSeries: string | null;
  premiseFloor: string | null;
  premiseUnitNo: string | null;
  premisePostalCode: string | null;
  premisePhone: string | null;
  premiseFax: string | null;
  premiseGeoPosition: PremiseGeoPosition | null;
  premisePublicAccess: PremisePublicAccess | null;
  registrationPlaceId: string | null;
  premiseOwnership: PremiseOwnership | null;
  premiseDeedNo: string | null;
  premiseArea: Prisma.Decimal | null;
  leaseIssuedAt: Date | null;
  leaseExpiresAt: Date | null;
  leaseAgency: string | null;
  premiseOwnerName: string | null;
};

function mapDossierLocation(row: DossierPlaceRow) {
  return {
    cityId: row.premiseCityId,
    establishment: row.premiseEstablishment,
    complexId: row.premiseComplexId,
    address: row.premiseAddress,
    addressEn: row.premiseAddressEn,
    plaque: row.premisePlaque,
    plaqueSeries: row.premisePlaqueSeries,
    floor: row.premiseFloor,
    unitNo: row.premiseUnitNo,
    postalCode: row.premisePostalCode,
    phone: row.premisePhone,
    fax: row.premiseFax,
    geoPosition: row.premiseGeoPosition,
    publicAccess: row.premisePublicAccess,
    registrationPlaceId: row.registrationPlaceId,
    ownership: row.premiseOwnership,
    deedNo: row.premiseDeedNo,
    area: decimalText(row.premiseArea),
    leaseIssuedAt: dateOnly(row.leaseIssuedAt),
    leaseExpiresAt: dateOnly(row.leaseExpiresAt),
    leaseAgency: row.leaseAgency,
    ownerName: row.premiseOwnerName,
  };
}

const dossierVersionSelect = {
  id: true,
  originalName: true,
  mimeType: true,
  byteSize: true,
  createdAt: true,
} satisfies Prisma.PersonDocumentVersionSelect;

const dossierPlaceSelect = {
  premiseCityId: true,
  premiseEstablishment: true,
  premiseComplexId: true,
  premiseAddress: true,
  premiseAddressEn: true,
  premisePlaque: true,
  premisePlaqueSeries: true,
  premiseFloor: true,
  premiseUnitNo: true,
  premisePostalCode: true,
  premisePhone: true,
  premiseFax: true,
  premiseGeoPosition: true,
  premisePublicAccess: true,
  registrationPlaceId: true,
  premiseOwnership: true,
  premiseDeedNo: true,
  premiseArea: true,
  leaseIssuedAt: true,
  leaseExpiresAt: true,
  leaseAgency: true,
  premiseOwnerName: true,
} satisfies Prisma.CaseFileSelect;

function storedDossierFile(
  version:
    | {
        id: string;
        originalName: string | null;
        mimeType: string;
        byteSize: number;
        createdAt: Date;
      }
    | undefined,
) {
  if (!version) return null;
  return {
    id: version.id,
    originalName: version.originalName,
    mimeType: version.mimeType,
    byteSize: version.byteSize,
    createdAt: version.createdAt.toISOString(),
  };
}

const FINANCIAL_REQUEST_TYPES = [
  CaseRequestType.ISSUANCE,
  CaseRequestType.RENEWAL,
  CaseRequestType.LOCATION_CHANGE,
  CaseRequestType.AUCTION,
  CaseRequestType.STEWARDSHIP,
] as const;

function money(value: { toString(): string } | number | string | null | undefined) {
  return Math.round(Number(value ?? 0));
}

type FeePaymentRow = {
  status: PaymentStatus;
  deletedAt: Date | null;
  subtotal: { toString(): string };
  discountAmount: { toString(): string };
  lines: { municipalFeeId: string | null; amount: { toString(): string } }[];
};

function feeStates(payments: FeePaymentRow[]) {
  const states = new Map<string, { status: 'PAID' | 'PENDING'; discount: number }>();
  for (const payment of payments) {
    if (payment.deletedAt) continue;
    if (payment.status !== PaymentStatus.PAID && payment.status !== PaymentStatus.PENDING) continue;
    const subtotal = money(payment.subtotal);
    const discount = money(payment.discountAmount);
    for (const line of payment.lines) {
      if (!line.municipalFeeId) continue;
      const share =
        subtotal > 0 && discount > 0 ? Math.round((discount * money(line.amount)) / subtotal) : 0;
      if (payment.status === PaymentStatus.PAID) {
        states.set(line.municipalFeeId, { status: 'PAID', discount: share });
      } else if (!states.has(line.municipalFeeId)) {
        states.set(line.municipalFeeId, { status: 'PENDING', discount: share });
      }
    }
  }
  return states;
}

function resolveListCaseKind(
  kind: string,
  requests: { type: string; status: string }[],
) {
  const current =
    requests.find((item) => item.status === CaseRequestStatus.OPEN) ??
    requests[0];
  if (
    kind === CaseFileKind.STEWARDSHIP ||
    current?.type === CaseRequestType.STEWARDSHIP
  ) {
    if (
      current &&
      (current.status === CaseRequestStatus.ISSUED ||
        current.status === CaseRequestStatus.COMPLETED)
    ) {
      return 'STEWARD_CARD';
    }
    return 'STEWARD_REQUEST';
  }
  if (current?.type === CaseRequestType.RENEWAL) return 'RENEWAL';
  if (current?.type === CaseRequestType.LOCATION_CHANGE) return 'LOCATION_CHANGE';
  if (current?.type === CaseRequestType.AUCTION) return 'AUCTION';
  return 'ISSUANCE';
}

function caseKindWhere(caseKind?: string): Prisma.CaseFileWhereInput {
  if (caseKind === 'STEWARD_REQUEST') {
    return { kind: CaseFileKind.LICENSE, stewardCases: { some: {} } };
  }
  if (caseKind === 'STEWARD_CARD') {
    return {
      requests: {
        some: {
          type: CaseRequestType.STEWARDSHIP,
          status: {
            in: [CaseRequestStatus.ISSUED, CaseRequestStatus.COMPLETED],
          },
        },
      },
    };
  }
  if (
    caseKind === CaseRequestType.ISSUANCE ||
    caseKind === CaseRequestType.RENEWAL ||
    caseKind === CaseRequestType.LOCATION_CHANGE ||
    caseKind === CaseRequestType.AUCTION
  ) {
    return { requests: { some: { type: caseKind } } };
  }
  return {};
}

function listOrder(
  sortBy: (typeof CASE_SORTS)[number] | undefined,
  sortDir: 'asc' | 'desc' | undefined,
): Prisma.CaseFileOrderByWithRelationInput[] {
  const dir = sortDir ?? 'asc';
  const tie = { id: 'asc' as const };
  switch (sortBy) {
    case 'fullName':
      return [{ user: { fullName: dir } }, tie];
    case 'nationalId':
      return [{ user: { nationalId: dir } }, tie];
    case 'job':
      return [{ activityJob: { title: dir } }, tie];
    case 'jobGroup':
      return [{ activityJob: { group: { title: dir } } }, tie];
    case 'jobType':
      return [{ activityJob: { jobType: { title: dir } } }, tie];
    case 'jobTitle':
    case 'businessUnitTitle':
      return [{ businessUnitTitle: dir }, tie];
    case 'licenseNumber':
      return [{ licenseNumber: dir }, tie];
    case 'formationStep':
      return [{ formationStep: dir }, tie];
    case 'status':
      return [{ status: dir }, tie];
    case 'updatedAt':
      return [{ updatedAt: dir }, tie];
    case 'createdAt':
      return [{ createdAt: dir }, tie];
    default:
      return [{ createdAt: 'desc' }, tie];
  }
}

export class CaseListQuery {
  @IsOptional()
  @IsString()
  q?: string;

  @Transform(({ value }) => Number(value ?? 1))
  @IsInt()
  @Min(1)
  page = 1;

  @Transform(({ value }) => Number(value ?? 10))
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize = 10;

  @IsOptional()
  @IsIn(CASE_SORTS)
  sortBy?: (typeof CASE_SORTS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  @IsOptional()
  @IsIn(CASE_STATUSES)
  status?: (typeof CASE_STATUSES)[number];

  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value == null ? undefined : Number(value),
  )
  @IsInt()
  @Min(0)
  @Max(6)
  step?: number;

  @IsOptional()
  @IsIn(CASE_KINDS)
  caseKind?: (typeof CASE_KINDS)[number];

  @IsOptional()
  @IsString()
  jobGroupId?: string;

  @IsOptional()
  @IsString()
  jobId?: string;
}

@Injectable()
export class CasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async list(userId: string, query: CaseListQuery) {
    const q = query.q?.trim();
    const digits = q ? latinDigits(q).replace(/\D/g, '') : '';
    const where: Prisma.CaseFileWhereInput = {
      userId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.step != null ? { formationStep: query.step } : {}),
      ...(query.jobId ? { activityJobId: query.jobId } : {}),
      ...(query.jobGroupId
        ? { activityJob: { groupId: query.jobGroupId } }
        : {}),
      ...caseKindWhere(query.caseKind),
      ...(q
        ? {
            OR: [
              { licenseNumber: { contains: q, mode: 'insensitive' } },
              { cardNumber: { contains: q, mode: 'insensitive' } },
              { businessUnitTitle: { contains: q, mode: 'insensitive' } },
              {
                hostCaseFile: {
                  businessUnitTitle: { contains: q, mode: 'insensitive' },
                },
              },
              { activityJob: { title: { contains: q, mode: 'insensitive' } } },
              {
                hostCaseFile: {
                  activityJob: { title: { contains: q, mode: 'insensitive' } },
                },
              },
              ...(digits
                ? [
                    { licenseNumber: { contains: digits } },
                    { cardNumber: { contains: digits } },
                  ]
                : []),
            ],
          }
        : {}),
    };
    const orderBy = listOrder(query.sortBy, query.sortDir);
    const select = {
      id: true,
      kind: true,
      status: true,
      formationStep: true,
      trackingCode: true,
      licenseNumber: true,
      licenseIssuedAt: true,
      licenseExpiresAt: true,
      cardNumber: true,
      cardIssuedAt: true,
      cardExpiresAt: true,
      businessUnitTitle: true,
      createdAt: true,
      updatedAt: true,
      activityJob: { select: listJobSelect },
      hostCaseFile: {
        select: {
          businessUnitTitle: true,
          activityJob: { select: listJobSelect },
        },
      },
      user: {
        select: { fullName: true, nationalId: true, photoId: true },
      },
      requests: {
        orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
        select: { type: true, status: true },
      },
      _count: { select: { requests: true } },
    } satisfies Prisma.CaseFileSelect;
    const [rows, total] = await Promise.all([
      this.prisma.caseFile.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy,
        select,
      }),
      this.prisma.caseFile.count({ where }),
    ]);
    const items = rows.map((row) => {
      const steward = row.kind === CaseFileKind.STEWARDSHIP;
      const { photoId, ...owner } = row.user;
      const job = steward
        ? row.hostCaseFile?.activityJob ?? null
        : row.activityJob;
      return {
        id: row.id,
        kind: row.kind,
        caseKind: resolveListCaseKind(row.kind, row.requests),
        requests: row.requests,
        status: row.status,
        formationStep: row.formationStep,
        trackingCode: row.trackingCode,
        licenseNumber: steward ? row.cardNumber : row.licenseNumber,
        licenseIssuedAt: dateOnly(steward ? row.cardIssuedAt : row.licenseIssuedAt),
        licenseExpiresAt: dateOnly(
          steward ? row.cardExpiresAt : row.licenseExpiresAt,
        ),
        businessUnitTitle: row.businessUnitTitle,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        activityJob: job,
        job,
        jobTitle: steward
          ? row.hostCaseFile?.businessUnitTitle ?? null
          : row.businessUnitTitle,
        fullName: owner.fullName,
        nationalId: owner.nationalId,
        hasPhoto: Boolean(photoId),
        _count: row._count,
      };
    });
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async detail(userId: string, caseId: string) {
    const row = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId },
      select: {
        id: true,
        kind: true,
        status: true,
        formationStep: true,
        trackingCode: true,
        licenseNumber: true,
        licenseIssuedAt: true,
        licenseExpiresAt: true,
        businessUnitTitle: true,
        previousOccupation: true,
        posDeviceCount: true,
        premiseAddress: true,
        premisePostalCode: true,
        premisePhone: true,
        premiseOwnership: true,
        premiseArea: true,
        createdAt: true,
        updatedAt: true,
        activityJob: {
          select: {
            id: true,
            title: true,
            group: { select: { id: true, title: true } },
          },
        },
        premiseCity: {
          select: {
            id: true,
            nameFa: true,
            province: { select: { id: true, nameFa: true } },
          },
        },
        premiseComplex: { select: { id: true, name: true } },
        registrationPlace: { select: { id: true, title: true } },
        user: { select: { nationalId: true } },
        _count: { select: { suspensions: true } },
        requests: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            number: true,
            type: true,
            status: true,
            formationStep: true,
            completedAt: true,
            createdAt: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException('پرونده یافت نشد');
    const { user: owner, _count, ...safeRow } = row;
    const violationCount = owner.nationalId
      ? await this.prisma.violation.count({
          where: { nationalId: owner.nationalId },
        })
      : 0;
    return {
      ...safeRow,
      violationCount,
      suspensionCount: _count.suspensions,
      futureActions: {
        renewal: { enabled: false },
        auction: { enabled: false },
        stewardship: { enabled: false },
        locationChange: { enabled: false },
      },
    };
  }

  async dossier(userId: string, caseId: string) {
    const file = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId },
      select: {
        id: true,
        kind: true,
        status: true,
        formationStep: true,
        trackingCode: true,
        licenseNumber: true,
        licenseIssuedAt: true,
        licenseExpiresAt: true,
        cardNumber: true,
        cardIssuedAt: true,
        cardExpiresAt: true,
        businessUnitTitle: true,
        previousOccupation: true,
        posDeviceCount: true,
        ...dossierPlaceSelect,
        activityJob: {
          select: {
            id: true,
            title: true,
            group: { select: { title: true } },
            jobType: { select: { title: true } },
          },
        },
        premiseCity: { select: { nameFa: true, nameEn: true } },
        premiseComplex: { select: { name: true, nameEn: true } },
        registrationPlace: { select: { title: true } },
        premiseHistory: {
          orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            startedAt: true,
            endedAt: true,
            ...dossierPlaceSelect,
            premiseCity: { select: { nameFa: true, nameEn: true } },
            premiseComplex: { select: { name: true, nameEn: true } },
            registrationPlace: { select: { title: true } },
          },
        },
        user: {
          select: {
            id: true,
            fullName: true,
            firstName: true,
            lastName: true,
            fatherName: true,
            lastNameEn: true,
            gender: true,
            religion: true,
            religionOther: true,
            nationalId: true,
            birthDate: true,
            residencyStatus: true,
            passportNumber: true,
            nationalCardExpiresAt: true,
            passportExpiresAt: true,
            identityCertificateNo: true,
            birthPlace: true,
            identityIssuedIn: true,
            countryId: true,
            phone: true,
            homePhone: true,
            postalCode: true,
            address: true,
            email: true,
            educationLevel: true,
            citizenGroup: true,
            jobId: true,
            country: { select: { nameFa: true, nameEn: true } },
            economicJob: { select: { id: true, title: true } },
            personDocuments: {
              orderBy: [{ document: { title: 'asc' } }, { id: 'asc' }],
              select: {
                documentId: true,
                document: {
                  select: {
                    title: true,
                    caseIdentityDocument: { select: { isRequired: true } },
                  },
                },
                versions: {
                  orderBy: { version: 'desc' },
                  take: 1,
                  select: dossierVersionSelect,
                },
              },
            },
          },
        },
        requests: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            type: true,
            number: true,
            status: true,
            createdAt: true,
            activityDocuments: {
              orderBy: [{ document: { title: 'asc' } }, { id: 'asc' }],
              select: {
                documentId: true,
                document: { select: { title: true } },
                versions: {
                  orderBy: { version: 'desc' },
                  take: 1,
                  select: dossierVersionSelect,
                },
              },
            },
          },
        },
        hostCaseFile: {
          select: {
            id: true,
            licenseNumber: true,
            businessUnitTitle: true,
            user: {
              select: { firstName: true, lastName: true, fullName: true },
            },
          },
        },
        stewardCases: {
          where: { kind: CaseFileKind.STEWARDSHIP },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          select: {
            id: true,
            status: true,
            cardNumber: true,
            cardIssuedAt: true,
            cardExpiresAt: true,
            user: { select: { fullName: true, nationalId: true } },
            requests: {
              where: { type: CaseRequestType.STEWARDSHIP },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
              select: { number: true, status: true },
            },
          },
        },
      },
    });
    if (!file) throw new NotFoundException('پرونده یافت نشد');
    const {
      personDocuments,
      birthDate,
      nationalCardExpiresAt,
      passportExpiresAt,
      ...person
    } = file.user;
    const steward = file.kind === CaseFileKind.STEWARDSHIP;
    return {
      id: file.id,
      kind: file.kind,
      status: file.status,
      formationStep: file.formationStep,
      trackingCode: file.trackingCode,
      licenseNumber: file.licenseNumber,
      licenseIssuedAt: dateOnly(file.licenseIssuedAt),
      licenseExpiresAt: dateOnly(file.licenseExpiresAt),
      cardNumber: file.cardNumber,
      cardIssuedAt: dateOnly(file.cardIssuedAt),
      cardExpiresAt: dateOnly(file.cardExpiresAt),
      businessUnitTitle: file.businessUnitTitle,
      person: {
        ...person,
        birthDate: dateOnly(birthDate),
        nationalCardExpiresAt: dateOnly(nationalCardExpiresAt),
        passportExpiresAt: dateOnly(passportExpiresAt),
      },
      activity: {
        businessUnitTitle: file.businessUnitTitle,
        jobGroupTitle: file.activityJob?.group?.title ?? null,
        jobTitle: file.activityJob?.title ?? null,
        jobTypeTitle: file.activityJob?.jobType?.title ?? null,
        previousOccupation: file.previousOccupation,
        posDeviceCount: file.posDeviceCount,
      },
      location: {
        ...mapDossierLocation(file),
        city: file.premiseCity,
        complex: file.premiseComplex,
        registrationPlaceTitle: file.registrationPlace?.title ?? null,
      },
      locationHistory: file.premiseHistory.map((row) => ({
        id: row.id,
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt.toISOString(),
        ...mapDossierLocation(row),
        city: row.premiseCity,
        complex: row.premiseComplex,
        registrationPlaceTitle: row.registrationPlace?.title ?? null,
      })),
      identityDocuments: personDocuments.flatMap((row) => {
        const current = storedDossierFile(row.versions[0]);
        if (!current) return [];
        return [
          {
            documentId: row.documentId,
            title: row.document.title,
            isRequired: row.document.caseIdentityDocument?.isRequired ?? false,
            file: current,
          },
        ];
      }),
      requestDocuments: file.requests.flatMap((request) => {
        const documents = request.activityDocuments.flatMap((row) => {
          const current = storedDossierFile(row.versions[0]);
          if (!current) return [];
          return [
            {
              documentId: row.documentId,
              title: row.document.title,
              isRequired: false,
              file: current,
            },
          ];
        });
        if (documents.length === 0) return [];
        return [
          {
            id: request.id,
            type: request.type,
            number: request.number,
            status: request.status,
            createdAt: request.createdAt.toISOString(),
            documents,
          },
        ];
      }),
      host:
        steward && file.hostCaseFile
          ? {
              id: file.hostCaseFile.id,
              licenseNumber: file.hostCaseFile.licenseNumber,
              businessUnitTitle: file.hostCaseFile.businessUnitTitle,
              fullName: file.hostCaseFile.user.fullName,
              firstName: file.hostCaseFile.user.firstName,
              lastName: file.hostCaseFile.user.lastName,
            }
          : null,
      stewards: steward
        ? []
        : file.stewardCases.map((row) => ({
            id: row.id,
            status: row.status,
            fullName: row.user.fullName,
            nationalId: row.user.nationalId,
            requestNumber: row.requests[0]?.number ?? null,
            requestStatus: row.requests[0]?.status ?? null,
            cardNumber: row.cardNumber,
            cardIssuedAt: dateOnly(row.cardIssuedAt),
            cardExpiresAt: dateOnly(row.cardExpiresAt),
          })),
    };
  }

  async license(userId: string, caseId: string) {
    const row = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId },
      select: {
        licenseNumber: true,
        licenseIssuedAt: true,
        licenseExpiresAt: true,
        trackingCode: true,
        businessUnitTitle: true,
        premiseAddress: true,
        premiseAddressEn: true,
        premisePhone: true,
        premisePostalCode: true,
        premisePlaque: true,
        premiseFloor: true,
        premiseUnitNo: true,
        activityJob: { select: { title: true, titleEn: true } },
        premiseCity: { select: { nameFa: true, nameEn: true } },
        premiseComplex: { select: { name: true, nameEn: true } },
        user: {
          select: {
            firstName: true,
            lastName: true,
            lastNameEn: true,
            gender: true,
            birthDate: true,
            passportNumber: true,
            photoId: true,
            country: { select: { nameFa: true, nameEn: true } },
          },
        },
        requests: {
          where: { type: 'ISSUANCE' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 1,
          select: { number: true },
        },
      },
    });
    if (!row) throw new NotFoundException('پرونده یافت نشد');
    const { photoId, ...owner } = row.user;
    return {
      licenseNumber: row.licenseNumber,
      issuedAt: dateOnly(row.licenseIssuedAt),
      expiresAt: dateOnly(row.licenseExpiresAt),
      requestNumber: row.requests[0]?.number ?? null,
      trackingCode: row.trackingCode,
      firstName: owner.firstName,
      lastName: owner.lastName,
      lastNameEn: owner.lastNameEn,
      gender: owner.gender,
      birthDate: dateOnly(owner.birthDate),
      nationalityFa: owner.country?.nameFa ?? null,
      nationalityEn: owner.country?.nameEn ?? null,
      passportNumber: owner.passportNumber,
      phone: row.premisePhone,
      tradeName: row.businessUnitTitle,
      activityTitle: row.activityJob?.title ?? null,
      activityTitleEn: row.activityJob?.titleEn ?? null,
      hasPhoto: Boolean(photoId),
      address: row.premiseAddress,
      addressEn: row.premiseAddressEn,
      plaque: row.premisePlaque,
      floor: row.premiseFloor,
      unitNo: row.premiseUnitNo,
      postalCode: row.premisePostalCode,
      cityNameFa: row.premiseCity?.nameFa ?? null,
      cityNameEn: row.premiseCity?.nameEn ?? null,
      complexName: row.premiseComplex?.name ?? null,
      complexNameEn: row.premiseComplex?.nameEn ?? null,
    };
  }

  async request(userId: string, requestId: string) {
    const row = await this.prisma.caseRequest.findFirst({
      where: { id: requestId, caseFile: { userId } },
      select: {
        id: true,
        caseFileId: true,
        number: true,
        type: true,
        status: true,
        formationStep: true,
        completedAt: true,
        createdAt: true,
        inquiries: {
          select: {
            id: true,
            status: true,
            note: true,
            referredAt: true,
            decidedAt: true,
            inquiryCenter: { select: { name: true } },
          },
        },
        placesReview: {
          select: {
            id: true,
            status: true,
            note: true,
            referredAt: true,
            decidedAt: true,
          },
        },
        managementReviews: {
          select: {
            id: true,
            status: true,
            note: true,
            decidedAt: true,
            role: { select: { name: true } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('درخواست یافت نشد');
    return row;
  }

  async finance(userId: string, caseId: string) {
    const file = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId },
      select: {
        id: true,
        businessUnitTitle: true,
        user: { select: { fullName: true, phone: true } },
      },
    });
    if (!file) throw new NotFoundException('پرونده یافت نشد');

    const requests = await this.prisma.caseRequest.findMany({
      where: {
        caseFileId: caseId,
        caseFile: { userId },
        type: { in: [...FINANCIAL_REQUEST_TYPES] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, number: true, type: true, status: true },
    });

    const items: Awaited<ReturnType<CasesService['requestFinanceView']>>[] = [];
    for (const request of requests) {
      await this.seedRequestFinance(request.id, request.type);
      items.push(await this.requestFinanceView(request));
    }

    const sum = (key: 'total' | 'paid' | 'discount' | 'pending' | 'remaining') =>
      items.reduce((total, item) => total + item.totals[key], 0);

    return {
      caseFile: {
        id: file.id,
        businessUnitTitle: file.businessUnitTitle,
      },
      payer: {
        fullName: file.user.fullName,
        phone: file.user.phone,
      },
      items,
      totals: {
        total: sum('total'),
        paid: sum('paid'),
        discount: sum('discount'),
        pending: sum('pending'),
        remaining: sum('remaining'),
      },
    };
  }

  private async seedRequestFinance(requestId: string, type: CaseRequestType) {
    const existing = await this.prisma.caseRequestFinance.findUnique({
      where: { requestId },
      select: { requestId: true },
    });
    if (existing) return;
    const setting = await this.prisma.financialRequestSetting.findUnique({
      where: { requestType: type },
      select: { bankAccountId: true },
    });
    if (!setting) return;
    const fees = await this.prisma.municipalFee.findMany({
      where: {
        bankAccountId: setting.bankAccountId,
        isActive: true,
        processTypes: { has: type },
      },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      select: { id: true, title: true, amount: true },
    });
    try {
      await this.prisma.caseRequestFinance.create({
        data: {
          requestId,
          bankAccountId: setting.bankAccountId,
          fees: {
            create: fees.map((fee, sortOrder) => ({
              municipalFeeId: fee.id,
              title: fee.title,
              amount: fee.amount,
              sortOrder,
            })),
          },
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
  }

  private async requestFinanceView(request: {
    id: string;
    number: string;
    type: CaseRequestType;
    status: CaseRequestStatus;
  }) {
    const [finance, payments] = await Promise.all([
      this.prisma.caseRequestFinance.findUnique({
        where: { requestId: request.id },
        select: {
          bankAccount: {
            select: { bankName: true, accountNumber: true, isActive: true },
          },
          fees: {
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              municipalFeeId: true,
              title: true,
              amount: true,
              municipalFee: { select: { isActive: true } },
            },
          },
        },
      }),
      this.prisma.payment.findMany({
        where: { caseRequestId: request.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          receiptNumber: true,
          method: true,
          status: true,
          paidAt: true,
          deletedAt: true,
          createdAt: true,
          subtotal: true,
          discountAmount: true,
          finalAmount: true,
          recordedBy: { select: { fullName: true } },
          caseRequest: { select: { id: true, number: true, type: true } },
          lines: {
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            select: { id: true, municipalFeeId: true, title: true, amount: true },
          },
        },
      }),
    ]);

    const states = feeStates(payments);
    const fees = (finance?.fees ?? []).map((fee) => {
      const state = states.get(fee.municipalFeeId);
      return {
        id: fee.id,
        title: fee.title,
        amount: money(fee.amount),
        isActive: fee.municipalFee.isActive,
        status: state?.status ?? ('UNPAID' as const),
        discount: state?.discount ?? 0,
      };
    });
    const paid = payments.filter((item) => !item.deletedAt && item.status === PaymentStatus.PAID);
    const sumFees = (status: string) =>
      fees.filter((fee) => fee.status === status).reduce((total, fee) => total + fee.amount, 0);

    return {
      request: {
        id: request.id,
        number: request.number,
        type: request.type,
        status: request.status,
      },
      finance: finance
        ? {
            bankAccount: finance.bankAccount,
            fees,
          }
        : null,
      payments: payments.map((row) => ({
        id: row.id,
        receiptNumber: row.receiptNumber,
        method: row.method,
        status: row.status,
        paidAt: row.paidAt?.toISOString() ?? null,
        deletedAt: row.deletedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        subtotal: money(row.subtotal),
        discountAmount: money(row.discountAmount),
        finalAmount: money(row.finalAmount),
        recordedBy: row.recordedBy.fullName,
        request: row.caseRequest,
        lines: row.lines.map((line) => ({
          id: line.id,
          title: line.title,
          amount: money(line.amount),
        })),
      })),
      totals: {
        total: fees.reduce((total, fee) => total + fee.amount, 0),
        paid: paid.reduce((total, item) => total + money(item.finalAmount), 0),
        discount: paid.reduce((total, item) => total + money(item.discountAmount), 0),
        pending: sumFees('PENDING'),
        remaining: sumFees('UNPAID'),
      },
    };
  }

  async remove(userId: string, caseId: string) {
    const file = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId },
      select: {
        id: true,
        licenseNumber: true,
        licenseIssuedAt: true,
        cardNumber: true,
      },
    });
    if (!file) throw new NotFoundException('پرونده یافت نشد');
    if (file.licenseNumber || file.licenseIssuedAt || file.cardNumber) {
      throw new BadRequestException('پرونده صادرشده قابل حذف نیست');
    }
    const dependents = await this.prisma.caseFile.findMany({
      where: { hostCaseFileId: file.id },
      select: { id: true, licenseNumber: true, cardNumber: true },
    });
    if (dependents.some((item) => item.licenseNumber || item.cardNumber)) {
      throw new BadRequestException('پرونده صادرشده قابل حذف نیست');
    }
    const caseIds = [file.id, ...dependents.map((item) => item.id)];
    const storageKeys = await this.collectCaseStorageKeys(caseIds);
    await this.prisma.$transaction(async (tx) => {
      const payments = await tx.payment.findMany({
        where: {
          OR: [
            { caseFileId: { in: caseIds } },
            { caseRequest: { caseFileId: { in: caseIds } } },
          ],
        },
        select: {
          id: true,
          receipts: { select: { imageId: true } },
        },
      });
      if (payments.length) {
        await tx.payment.deleteMany({
          where: { id: { in: payments.map((item) => item.id) } },
        });
        const imageIds = payments.flatMap((item) =>
          item.receipts.map((receipt) => receipt.imageId),
        );
        if (imageIds.length) {
          await tx.storedImage.deleteMany({ where: { id: { in: imageIds } } });
        }
      }
      if (dependents.length) {
        await tx.caseFile.deleteMany({
          where: { id: { in: dependents.map((item) => item.id) } },
        });
      }
      await tx.caseFile.delete({ where: { id: file.id } });
    });
    await this.removeStorageKeys(storageKeys);
    return { ok: true };
  }

  private async collectCaseStorageKeys(caseIds: string[]) {
    const [
      activityFiles,
      suspensionFiles,
      stewardRevokeFiles,
      inquiryFiles,
      placesFiles,
      managementFiles,
    ] = await Promise.all([
      this.prisma.caseActivityDocumentVersion.findMany({
        where: { caseActivityDocument: { caseFileId: { in: caseIds } } },
        select: { storageKey: true },
      }),
      this.prisma.caseSuspensionFile.findMany({
        where: { suspension: { caseFileId: { in: caseIds } } },
        select: { storageKey: true },
      }),
      this.prisma.caseStewardRevokeFile.findMany({
        where: { caseFileId: { in: caseIds } },
        select: { storageKey: true },
      }),
      this.prisma.caseInquiryFile.findMany({
        where: { caseInquiry: { caseFileId: { in: caseIds } } },
        select: { storageKey: true },
      }),
      this.prisma.casePlacesFile.findMany({
        where: { review: { caseFileId: { in: caseIds } } },
        select: { storageKey: true },
      }),
      this.prisma.caseManagementReviewFile.findMany({
        where: { review: { caseFileId: { in: caseIds } } },
        select: { storageKey: true },
      }),
    ]);
    return [
      ...activityFiles.map((item) => item.storageKey),
      ...suspensionFiles.map((item) => item.storageKey),
      ...stewardRevokeFiles.map((item) => item.storageKey),
      ...inquiryFiles.map((item) => item.storageKey),
      ...placesFiles.map((item) => item.storageKey),
      ...managementFiles.map((item) => item.storageKey),
    ];
  }

  private async removeStorageKeys(keys: string[]) {
    const root = path.resolve(this.config.getOrThrow<string>('storage.root'));
    await Promise.all(
      keys.map(async (key) => {
        const absolute = path.resolve(root, key);
        if (!absolute.startsWith(`${root}${path.sep}`)) return;
        await unlink(absolute).catch(() => undefined);
      }),
    );
  }

  async document(userId: string, versionId: string) {
    const person = await this.prisma.personDocumentVersion.findFirst({
      where: { id: versionId, personDocument: { userId } },
      select: {
        storageKey: true,
        originalName: true,
        mimeType: true,
        byteSize: true,
      },
    });
    const activity = person
      ? null
      : await this.prisma.caseActivityDocumentVersion.findFirst({
          where: {
            id: versionId,
            caseActivityDocument: { caseFile: { userId } },
          },
          select: {
            storageKey: true,
            originalName: true,
            mimeType: true,
            byteSize: true,
          },
        });
    const file = person ?? activity;
    if (!file) throw new NotFoundException('فایل یافت نشد');
    const root = path.resolve(this.config.getOrThrow<string>('storage.root'));
    const absolute = path.resolve(root, file.storageKey);
    if (!absolute.startsWith(`${root}${path.sep}`))
      throw new NotFoundException('فایل یافت نشد');
    return { ...file, absolute };
  }

  private async assertOwnedCase(userId: string, caseId: string) {
    const row = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('پرونده یافت نشد');
    return row;
  }
}

@Controller('cases')
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Get('documents/:versionId/file')
  async file(
    @CurrentUser() user: PortalUser,
    @Param('versionId') versionId: string,
    @Res() response: Response,
  ) {
    const file = await this.cases.document(user.id, versionId);
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', String(file.byteSize));
    response.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(file.originalName ?? 'document')}`,
    );
    createReadStream(file.absolute).pipe(response);
  }

  @Get()
  list(@CurrentUser() user: PortalUser, @Query() query: CaseListQuery) {
    return this.cases.list(user.id, query);
  }

  @Get(':caseId')
  detail(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.cases.detail(user.id, caseId);
  }

  @Get(':caseId/finance')
  finance(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.cases.finance(user.id, caseId);
  }

  @Get(':caseId/dossier')
  dossier(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.cases.dossier(user.id, caseId);
  }

  @Get(':caseId/license')
  license(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.cases.license(user.id, caseId);
  }

  @Delete(':caseId')
  remove(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.cases.remove(user.id, caseId);
  }

  @Get('requests/:requestId')
  request(
    @CurrentUser() user: PortalUser,
    @Param('requestId') requestId: string,
  ) {
    return this.cases.request(user.id, requestId);
  }

}

@Module({
  controllers: [CasesController],
  providers: [CasesService],
  exports: [CasesService],
})
export class CasesModule {}
