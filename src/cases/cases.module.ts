import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  removeStoredKeys,
  resolveStoredAbsolute,
} from '../storage/stored-file';
import { CurrentUser, PortalUser } from '../auth/auth.module';
import {
  CaseFileKind,
  CaseFileStatus,
  CaseRevokeSource,
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
import { CreatePortalStewardDto } from './dto/create-portal-steward.dto';
import { RevokePortalStewardshipDto } from './dto/revoke-portal-stewardship.dto';
import { SavePortalAuctionDto } from './dto/save-portal-auction.dto';
import { PortalAuctionService } from './portal-auction.service';
import { PortalLettersService } from './portal-letters.service';
import {
  PortalRenewalService,
  UploadPortalRenewalDocumentDto,
} from './portal-renewal.service';
import { PortalLocationService } from './portal-location.service';
import { SavePortalLocationDto } from './dto/save-portal-location.dto';
import {
  PortalStewardshipService,
  portalStewardshipActionEnabled,
} from './portal-stewardship.service';
import { SmsModule } from '../sms/sms.module';
import {
  PortalStewardFormationService,
  UploadPortalStewardDocumentDto,
} from './portal-steward-formation.service';
import { SavePortalStewardIdentityDto } from './dto/save-portal-steward-identity.dto';

const upload = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

type UploadFile = {
  buffer: Buffer;
  size: number;
  mimetype: string;
  originalname: string;
};

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

function requestInquiryStep(type: CaseRequestType) {
  if (type === CaseRequestType.ISSUANCE) return 3;
  if (type === CaseRequestType.STEWARDSHIP) return 1;
  if (type === CaseRequestType.RENEWAL || type === CaseRequestType.LOCATION_CHANGE) return 2;
  if (type === CaseRequestType.AUCTION) return 1;
  return 0;
}

function latinDigits(value: string) {
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  return value.replace(/[۰-۹٠-٩]/g, (char) => {
    const persianIndex = persian.indexOf(char);
    return String(persianIndex >= 0 ? persianIndex : arabic.indexOf(char));
  });
}

function parseIsoDateOnly(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function localTodayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function uploadExtension(mimeType: string) {
  if (mimeType === 'application/pdf') return '.pdf';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType.startsWith('audio/')) return '.webm';
  return '.jpg';
}

function dateOnly(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function imageDataUrl(image: { mimeType: string; data: Buffer | Uint8Array } | null | undefined) {
  if (!image) return null;
  return `data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')}`;
}

function utcDay(value: Date) {
  return Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
  );
}

function tehranToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${parts}T00:00:00.000Z`);
}

function suspensionIsActive(row: {
  startsAt: Date;
  endsAt: Date | null;
  liftedAt: Date | null;
}) {
  if (row.liftedAt) return false;
  const today = tehranToday();
  if (utcDay(row.startsAt) > utcDay(today)) return false;
  if (!row.endsAt) return true;
  return utcDay(row.endsAt) >= utcDay(today);
}

const portalViolationSelect = {
  id: true,
  nationalId: true,
  occurredAt: true,
  description: true,
  status: true,
  violationType: { select: { id: true, title: true } },
  caseFile: { select: { id: true, businessUnitTitle: true } },
  attachments: {
    orderBy: { sortOrder: 'asc' as const },
    select: {
      id: true,
      kind: true,
      originalName: true,
      image: { select: { mimeType: true } },
      file: { select: { mimeType: true } },
    },
  },
} satisfies Prisma.ViolationSelect;

function mapPortalViolation(
  item: Prisma.ViolationGetPayload<{ select: typeof portalViolationSelect }>,
) {
  return {
    id: item.id,
    nationalId: item.nationalId,
    description: item.description,
    status: item.status,
    violationType: item.violationType,
    caseFile: item.caseFile
      ? {
          id: item.caseFile.id,
          businessUnitTitle: item.caseFile.businessUnitTitle,
        }
      : null,
    occurredAt: dateOnly(item.occurredAt),
    attachments: item.attachments.map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      originalName: attachment.originalName,
      mimeType: attachment.file?.mimeType ?? attachment.image?.mimeType ?? null,
    })),
  };
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
      return [
        { licenseNumber: dir },
        { hostCaseFile: { licenseNumber: dir } },
        { cardNumber: dir },
        tie,
      ];
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
              {
                hostCaseFile: {
                  licenseNumber: { contains: q, mode: 'insensitive' },
                },
              },
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
                    { hostCaseFile: { licenseNumber: { contains: digits } } },
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
          licenseNumber: true,
          licenseExpiresAt: true,
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
        hostLicenseNumber: steward
          ? row.hostCaseFile?.licenseNumber ?? null
          : null,
        hostLicenseExpiresAt: steward
          ? dateOnly(row.hostCaseFile?.licenseExpiresAt ?? null)
          : null,
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
        cardNumber: true,
        cardIssuedAt: true,
        cardExpiresAt: true,
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
            jobType: { select: { id: true, title: true } },
          },
        },
        hostCaseFile: {
          select: {
            id: true,
            licenseNumber: true,
            licenseIssuedAt: true,
            licenseExpiresAt: true,
            businessUnitTitle: true,
            premiseCity: {
              select: {
                id: true,
                nameFa: true,
                province: { select: { id: true, nameFa: true } },
              },
            },
            activityJob: {
              select: {
                id: true,
                title: true,
                group: { select: { id: true, title: true } },
                jobType: { select: { id: true, title: true } },
              },
            },
            user: {
              select: {
                firstName: true,
                lastName: true,
                fullName: true,
                phone: true,
              },
            },
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
        user: {
          select: {
            nationalId: true,
            fullName: true,
            firstName: true,
            lastName: true,
            phone: true,
          },
        },
        _count: { select: { suspensions: true } },
        suspensions: {
          orderBy: [
            { startsAt: 'desc' },
            { createdAt: 'desc' },
            { id: 'desc' },
          ],
          select: {
            id: true,
            reason: true,
            startsAt: true,
            endsAt: true,
            liftNote: true,
            liftedAt: true,
            files: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: {
                id: true,
                kind: true,
                originalName: true,
                mimeType: true,
              },
            },
          },
        },
        requests: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            number: true,
            type: true,
            status: true,
            formationStep: true,
            intakeSubmittedAt: true,
            completedAt: true,
            createdAt: true,
            _count: { select: { inquiries: true, payments: true } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('پرونده یافت نشد');
    const { user: owner, _count, suspensions, hostCaseFile, requests, ...safeRow } = row;
    const steward = row.kind === CaseFileKind.STEWARDSHIP;
    const hostJob = hostCaseFile?.activityJob ?? null;
    const violationCount = owner.nationalId
      ? await this.prisma.violation.count({
          where: { nationalId: owner.nationalId },
        })
      : 0;
    return {
      ...safeRow,
      activityJob: steward ? hostJob : row.activityJob,
      businessUnitTitle: steward
        ? hostCaseFile?.businessUnitTitle ?? row.businessUnitTitle
        : row.businessUnitTitle,
      premiseCity: steward
        ? hostCaseFile?.premiseCity ?? row.premiseCity
        : row.premiseCity,
      hostLicenseNumber: steward ? hostCaseFile?.licenseNumber ?? null : null,
      hostLicenseIssuedAt: steward
        ? dateOnly(hostCaseFile?.licenseIssuedAt ?? null)
        : null,
      hostLicenseExpiresAt: steward
        ? dateOnly(hostCaseFile?.licenseExpiresAt ?? null)
        : null,
      host:
        steward && hostCaseFile
          ? {
              id: hostCaseFile.id,
              licenseNumber: hostCaseFile.licenseNumber,
              businessUnitTitle: hostCaseFile.businessUnitTitle,
              firstName: hostCaseFile.user.firstName,
              lastName: hostCaseFile.user.lastName,
              fullName: hostCaseFile.user.fullName,
              phone: hostCaseFile.user.phone,
              jobGroupTitle: hostCaseFile.activityJob?.group?.title ?? null,
              jobTitle: hostCaseFile.activityJob?.title ?? null,
              jobTypeTitle: hostCaseFile.activityJob?.jobType?.title ?? null,
            }
          : null,
      requests: requests.map(({ _count: counts, ...request }) => ({
        ...request,
        canCancel:
          request.status === CaseRequestStatus.OPEN &&
          request.formationStep < requestInquiryStep(request.type) &&
          counts.inquiries === 0 &&
          counts.payments === 0,
      })),
      cardNumber: row.cardNumber,
      cardIssuedAt: dateOnly(row.cardIssuedAt),
      cardExpiresAt: dateOnly(row.cardExpiresAt),
      ownerName: owner.fullName,
      ownerFirstName: owner.firstName,
      ownerLastName: owner.lastName,
      ownerPhone: owner.phone,
      ownerNationalId: owner.nationalId,
      violationCount,
      suspensionCount: _count.suspensions,
      suspensions: suspensions.map((item) => ({
        id: item.id,
        reason: item.reason,
        startsAt: dateOnly(item.startsAt),
        endsAt: dateOnly(item.endsAt),
        liftNote: item.liftNote,
        active: suspensionIsActive(item),
        files: item.files,
      })),
      futureActions: {
        renewal: {
          enabled:
            row.kind === CaseFileKind.LICENSE &&
            row.status !== CaseFileStatus.REVOKED &&
            (Boolean(row.licenseNumber) ||
              row.requests.some((request) => request.type === CaseRequestType.RENEWAL)),
        },
        auction: {
          enabled:
            row.kind === CaseFileKind.LICENSE &&
            Boolean(row.licenseNumber) &&
            row.status !== CaseFileStatus.REVOKED &&
            row.status !== CaseFileStatus.EXPIRED &&
            !row.requests.some(
              (request) =>
                request.status === CaseRequestStatus.OPEN && request.type !== CaseRequestType.AUCTION,
            ),
        },
        stewardship: {
          enabled: portalStewardshipActionEnabled({
            kind: row.kind,
            status: row.status,
            licenseNumber: row.licenseNumber,
            suspensions,
          }),
        },
        locationChange: {
          enabled:
            row.kind === CaseFileKind.LICENSE &&
            Boolean(row.licenseNumber) &&
            row.status !== CaseFileStatus.REVOKED &&
            row.status !== CaseFileStatus.EXPIRED &&
            !row.requests.some(
              (request) =>
                request.status === CaseRequestStatus.OPEN &&
                request.type !== CaseRequestType.LOCATION_CHANGE,
            ),
        },
      },
    };
  }

  async violations(userId: string, caseId: string) {
    const owner = await this.ownedIdentity(userId, caseId);
    if (!owner.user.nationalId) return [];
    const items = await this.prisma.violation.findMany({
      where: { nationalId: owner.user.nationalId },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      select: portalViolationSelect,
    });
    return items.map(mapPortalViolation);
  }

  async violation(userId: string, caseId: string, violationId: string) {
    const owner = await this.ownedIdentity(userId, caseId);
    if (!owner.user.nationalId) throw new NotFoundException('تخلف یافت نشد');
    const item = await this.prisma.violation.findFirst({
      where: { id: violationId, nationalId: owner.user.nationalId },
      select: portalViolationSelect,
    });
    if (!item) throw new NotFoundException('تخلف یافت نشد');
    return mapPortalViolation(item);
  }

  async violationAttachment(
    userId: string,
    caseId: string,
    violationId: string,
    attachmentId: string,
  ) {
    const owner = await this.ownedIdentity(userId, caseId);
    if (!owner.user.nationalId) throw new NotFoundException('پیوست یافت نشد');
    const attachment = await this.prisma.violationAttachment.findFirst({
      where: {
        id: attachmentId,
        violationId,
        violation: { nationalId: owner.user.nationalId },
      },
      select: {
        originalName: true,
        image: { select: { mimeType: true, data: true, originalName: true } },
        file: { select: { mimeType: true, data: true, originalName: true } },
      },
    });
    const blob = attachment?.image ?? attachment?.file;
    if (!attachment || !blob) throw new NotFoundException('پیوست یافت نشد');
    return {
      mimeType: blob.mimeType,
      data: Buffer.from(blob.data),
      name: attachment.originalName || blob.originalName || 'file',
    };
  }

  async suspensionFile(userId: string, caseId: string, fileId: string) {
    const file = await this.prisma.caseSuspensionFile.findFirst({
      where: {
        id: fileId,
        suspension: { caseFileId: caseId, caseFile: { userId } },
      },
      select: {
        storageKey: true,
        originalName: true,
        mimeType: true,
        byteSize: true,
      },
    });
    if (!file) throw new NotFoundException('پیوست یافت نشد');
    const absolute = await resolveStoredAbsolute(
      file.storageKey,
      this.config.getOrThrow<string>('storage.root'),
      'پیوست یافت نشد',
    );
    return { ...file, absolute };
  }

  private async ownedIdentity(userId: string, caseId: string) {
    const row = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId },
      select: {
        id: true,
        user: { select: { nationalId: true, fullName: true } },
      },
    });
    if (!row) throw new NotFoundException('پرونده یافت نشد');
    return row;
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
            user: { select: { firstName: true, lastName: true, fullName: true, nationalId: true, phone: true } },
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
    const host = file.hostCaseFile;
    const activitySource = steward && host ? host : file;
    const locationSource = steward && host ? host : file;
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
      businessUnitTitle: steward
        ? host?.businessUnitTitle ?? file.businessUnitTitle
        : file.businessUnitTitle,
      person: {
        ...person,
        birthDate: dateOnly(birthDate),
        nationalCardExpiresAt: dateOnly(nationalCardExpiresAt),
        passportExpiresAt: dateOnly(passportExpiresAt),
      },
      activity: {
        businessUnitTitle: activitySource.businessUnitTitle,
        jobGroupTitle: activitySource.activityJob?.group?.title ?? null,
        jobTitle: activitySource.activityJob?.title ?? null,
        jobTypeTitle: activitySource.activityJob?.jobType?.title ?? null,
        previousOccupation: activitySource.previousOccupation,
        posDeviceCount: activitySource.posDeviceCount,
      },
      location: {
        ...mapDossierLocation(locationSource),
        city: locationSource.premiseCity,
        complex: locationSource.premiseComplex,
        registrationPlaceTitle: locationSource.registrationPlace?.title ?? null,
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
            firstName: row.user.firstName,
            lastName: row.user.lastName,
            fullName: row.user.fullName,
            nationalId: row.user.nationalId,
            phone: row.user.phone,
            requestNumber: row.requests[0]?.number ?? null,
            requestStatus: row.requests[0]?.status ?? null,
            cardNumber: row.cardNumber,
            cardIssuedAt: dateOnly(row.cardIssuedAt),
            cardExpiresAt: dateOnly(row.cardExpiresAt),
          })),
    };
  }

  async stewardship(userId: string, caseId: string) {
    const file = await this.prisma.caseFile.findFirst({
      where: {
        id: caseId,
        kind: CaseFileKind.STEWARDSHIP,
        OR: [{ userId }, { hostCaseFile: { userId } }],
      },
      select: {
        id: true,
        userId: true,
        status: true,
        cardNumber: true,
        cardIssuedAt: true,
        cardExpiresAt: true,
        revokeReason: true,
        revokeSource: true,
        revokeRequestedAt: true,
        revokedAt: true,
        revokedBy: {
          select: { firstName: true, lastName: true, fullName: true },
        },
        user: {
          select: {
            fullName: true,
            firstName: true,
            lastName: true,
            nationalId: true,
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
            activityJob: {
              select: {
                title: true,
                group: { select: { title: true } },
              },
            },
          },
        },
      },
    });
    if (!file) throw new NotFoundException('پرونده یافت نشد');
    const revoked = file.status === CaseFileStatus.REVOKED;
    return {
      id: file.id,
      viewerIsHolder: file.userId === userId,
      status: file.status,
      cardNumber: file.cardNumber,
      cardIssuedAt: dateOnly(file.cardIssuedAt),
      cardExpiresAt: dateOnly(file.cardExpiresAt),
      revokeReason: revoked ? file.revokeReason : null,
      revokeSource: revoked ? file.revokeSource : null,
      revokeRequestedAt: revoked ? (file.revokeRequestedAt?.toISOString() ?? null) : null,
      revokedAt: revoked ? dateOnly(file.revokedAt) : null,
      revokedBy:
        revoked && file.revokedBy
          ? {
              firstName: file.revokedBy.firstName,
              lastName: file.revokedBy.lastName,
              fullName: file.revokedBy.fullName,
            }
          : null,
      person: file.user,
      host: file.hostCaseFile
        ? {
            id: file.hostCaseFile.id,
            licenseNumber: file.hostCaseFile.licenseNumber,
            businessUnitTitle: file.hostCaseFile.businessUnitTitle,
            firstName: file.hostCaseFile.user.firstName,
            lastName: file.hostCaseFile.user.lastName,
            fullName: file.hostCaseFile.user.fullName,
            jobTitle: file.hostCaseFile.activityJob?.title ?? null,
            jobGroupTitle: file.hostCaseFile.activityJob?.group?.title ?? null,
          }
        : null,
    };
  }

  async revokeStewardship(
    userId: string,
    caseId: string,
    dto: RevokePortalStewardshipDto,
    upload?: UploadFile,
  ) {
    const text = dto.reason.trim();
    if (!text) throw new BadRequestException('متن درخواست را وارد کنید');
    const revokedAt =
      (dto.revokedAt ? parseIsoDateOnly(dto.revokedAt) : null) ??
      parseIsoDateOnly(localTodayIso());
    if (!revokedAt) throw new BadRequestException('تاریخ ابطال مباشرت معتبر نیست');
    const file = await this.prisma.caseFile.findFirst({
      where: {
        id: caseId,
        kind: CaseFileKind.STEWARDSHIP,
        OR: [{ userId }, { hostCaseFile: { userId } }],
      },
      select: {
        id: true,
        userId: true,
        status: true,
        cardNumber: true,
        requests: {
          where: { status: CaseRequestStatus.OPEN },
          select: { id: true },
        },
      },
    });
    if (!file) throw new NotFoundException('پرونده یافت نشد');
    if (!file.cardNumber) {
      throw new BadRequestException('کارت مباشرت هنوز صادر نشده است');
    }
    if (file.status === CaseFileStatus.REVOKED) {
      throw new BadRequestException('این کارت قبلاً ابطال شده است');
    }
    if (file.status !== CaseFileStatus.ACTIVE) {
      throw new BadRequestException('فقط پرونده فعال قابل ابطال است');
    }
    const requestedAt = new Date();
    const revokeSource =
      file.userId === userId ? CaseRevokeSource.STEWARD : CaseRevokeSource.HOST;
    let storageKey: string | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.caseFile.update({
          where: { id: file.id },
          data: {
            status: CaseFileStatus.REVOKED,
            revokeReason: text,
            revokeSource,
            revokeRequestedAt: requestedAt,
            revokedAt,
            revokedById: userId,
            reactivatedAt: null,
          },
        });
        if (upload?.buffer?.length) {
          const fileId = randomUUID();
          const ext = uploadExtension(upload.mimetype);
          storageKey = [
            'persons',
            file.userId,
            'cases',
            file.id,
            'steward-revoke',
            `${fileId}${ext}`,
          ].join('/');
          const root = path.resolve(this.config.getOrThrow<string>('storage.root'));
          const absolute = path.resolve(root, storageKey);
          if (!absolute.startsWith(`${root}${path.sep}`)) {
            throw new BadRequestException('مسیر فایل معتبر نیست');
          }
          await mkdir(path.dirname(absolute), { recursive: true });
          await writeFile(absolute, upload.buffer);
          await tx.caseStewardRevokeFile.create({
            data: {
              id: fileId,
              caseFileId: file.id,
              storageKey,
              originalName: upload.originalname,
              mimeType: upload.mimetype,
              byteSize: upload.size,
            },
          });
        }
        if (file.requests.length) {
          await tx.caseRequest.updateMany({
            where: { id: { in: file.requests.map((row) => row.id) } },
            data: { status: CaseRequestStatus.CANCELLED },
          });
        }
      });
    } catch (error) {
      if (storageKey) {
        const root = path.resolve(this.config.getOrThrow<string>('storage.root'));
        await unlink(path.resolve(root, storageKey)).catch(() => undefined);
      }
      throw error;
    }
    return {
      id: file.id,
      status: CaseFileStatus.REVOKED,
      revokedAt: dateOnly(revokedAt),
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
            country: { select: { iso2: true, nameFa: true, nameEn: true } },
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
    const stamp = row.licenseNumber
      ? await this.prisma.caseActivityLicenseSettings.findUnique({
          where: { id: 'default' },
          select: {
            signerName: true,
            signerTitle: true,
            signature: { select: { mimeType: true, data: true } },
          },
        })
      : null;
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
      nationalityIso2: owner.country?.iso2 ?? null,
      nationalityFa: owner.country?.nameFa ?? null,
      nationalityEn: owner.country?.nameEn ?? null,
      passportNumber: owner.passportNumber,
      phone: row.premisePhone,
      tradeName: row.businessUnitTitle,
      activityTitle: row.activityJob?.title ?? null,
      activityTitleEn: row.activityJob?.titleEn ?? null,
      hasPhoto: Boolean(photoId),
      signerName: stamp?.signerName ?? null,
      signerTitle: stamp?.signerTitle ?? null,
      signatureDataUrl: imageDataUrl(stamp?.signature),
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

  async cancelRequest(userId: string, caseId: string, requestId: string) {
    const file = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId },
      select: {
        id: true,
        kind: true,
        licenseNumber: true,
        cardNumber: true,
      },
    });
    if (!file) throw new NotFoundException('پرونده یافت نشد');
    const request = await this.prisma.caseRequest.findFirst({
      where: { id: requestId, caseFileId: file.id },
      select: {
        id: true,
        type: true,
        status: true,
        formationStep: true,
        _count: { select: { inquiries: true, payments: true } },
      },
    });
    if (!request) throw new NotFoundException('درخواست یافت نشد');
    if (request.status !== CaseRequestStatus.OPEN) {
      throw new BadRequestException('فقط درخواست باز قابل حذف است');
    }
    if (
      request.formationStep >= requestInquiryStep(request.type) ||
      request._count.inquiries > 0
    ) {
      throw new BadRequestException('پس از ارسال استعلام، حذف درخواست ممکن نیست');
    }
    if (request._count.payments > 0) {
      throw new BadRequestException('برای این درخواست پرداخت ثبت شده و حذف ممکن نیست');
    }
    const deletesWholeCase =
      (request.type === CaseRequestType.ISSUANCE && !file.licenseNumber) ||
      (request.type === CaseRequestType.STEWARDSHIP && !file.cardNumber);
    if (deletesWholeCase) {
      await this.remove(userId, caseId);
      return { ok: true, deletedCase: true };
    }
    const storageKeys = await this.prisma.caseActivityDocumentVersion.findMany({
      where: { caseActivityDocument: { caseRequestId: request.id } },
      select: { storageKey: true },
    });
    await this.prisma.caseRequest.delete({ where: { id: request.id } });
    await this.removeStorageKeys(storageKeys.map((item) => item.storageKey));
    return { ok: true, deletedCase: false };
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
    await removeStoredKeys(keys, this.config.getOrThrow<string>('storage.root'));
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
    const absolute = await resolveStoredAbsolute(
      file.storageKey,
      this.config.getOrThrow<string>('storage.root'),
    );
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
  constructor(
    private readonly cases: CasesService,
    private readonly auctions: PortalAuctionService,
    private readonly renewals: PortalRenewalService,
    private readonly locations: PortalLocationService,
    private readonly letters: PortalLettersService,
    private readonly stewardshipPortal: PortalStewardshipService,
    private readonly stewardFormation: PortalStewardFormationService,
  ) {}

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

  @Get(':caseId/violations/:violationId/attachments/:attachmentId')
  async violationAttachment(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('violationId') violationId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() response: Response,
  ) {
    const file = await this.cases.violationAttachment(
      user.id,
      caseId,
      violationId,
      attachmentId,
    );
    const ascii = file.name.replace(/[^\w.\-]+/g, '_') || 'file';
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', String(file.data.length));
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    response.send(file.data);
  }

  @Get(':caseId/violations/:violationId')
  violation(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('violationId') violationId: string,
  ) {
    return this.cases.violation(user.id, caseId, violationId);
  }

  @Get(':caseId/violations')
  violations(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.cases.violations(user.id, caseId);
  }

  @Get(':caseId/suspensions/files/:fileId')
  async suspensionFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.cases.suspensionFile(user.id, caseId, fileId);
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', String(file.byteSize));
    response.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(file.originalName ?? 'file')}`,
    );
    createReadStream(file.absolute).pipe(response);
  }

  @Get(':caseId/auction/:requestId/inquiries/:inquiryId/letter')
  auctionInquiryLetter(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Param('inquiryId') inquiryId: string,
  ) {
    return this.letters.inquiryLetter(user.id, caseId, inquiryId, CaseRequestType.AUCTION, requestId);
  }

  @Get(':caseId/auction/:requestId/places/letter')
  auctionPlacesLetter(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.letters.placesLetter(user.id, caseId, CaseRequestType.AUCTION, requestId);
  }

  @Get(':caseId/auction/:requestId/inquiries/:inquiryId/files/:fileId')
  async auctionInquiryFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Param('inquiryId') inquiryId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.auctions.inquiryFile(user.id, caseId, requestId, inquiryId, fileId);
    this.sendStoredFile(response, file);
  }

  @Get(':caseId/auction/:requestId/places/files/:fileId')
  async auctionPlacesFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.auctions.placesFile(user.id, caseId, requestId, fileId);
    this.sendStoredFile(response, file);
  }

  @Get(':caseId/auction/:requestId/management-reviews/:reviewId/files/:fileId')
  async auctionReviewFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Param('reviewId') reviewId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.auctions.reviewFile(user.id, caseId, requestId, reviewId, fileId);
    const ascii = (file.originalName ?? 'file').replace(/[^\w.\-]+/g, '_') || 'file';
    response.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    response.setHeader('Content-Length', String(file.data.length));
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.originalName ?? 'file')}`,
    );
    response.send(file.data);
  }

  @Get(':caseId/auction/:requestId')
  auction(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.auctions.find(user.id, caseId, requestId);
  }

  @Post(':caseId/auction')
  createAuction(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Body() dto: SavePortalAuctionDto,
  ) {
    return this.auctions.create(user.id, caseId, dto);
  }

  @Patch(':caseId/auction/:requestId')
  updateAuction(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Body() dto: SavePortalAuctionDto,
  ) {
    return this.auctions.update(user.id, caseId, requestId, dto);
  }

  @Get(':caseId/renewal/:requestId/inquiries/:inquiryId/letter')
  renewalInquiryLetter(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Param('inquiryId') inquiryId: string,
  ) {
    return this.letters.inquiryLetter(user.id, caseId, inquiryId, CaseRequestType.RENEWAL, requestId);
  }

  @Get(':caseId/renewal/:requestId/places/letter')
  renewalPlacesLetter(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.letters.placesLetter(user.id, caseId, CaseRequestType.RENEWAL, requestId);
  }

  @Get(':caseId/renewal/:requestId/inquiries/:inquiryId/files/:fileId')
  async renewalInquiryFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Param('inquiryId') inquiryId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.renewals.inquiryFile(
      user.id,
      caseId,
      requestId,
      inquiryId,
      fileId,
    );
    this.sendStoredFile(response, file);
  }

  @Get(':caseId/renewal/:requestId/places/files/:fileId')
  async renewalPlacesFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.renewals.placesFile(user.id, caseId, requestId, fileId);
    this.sendStoredFile(response, file);
  }

  @Get(':caseId/renewal/:requestId/management-reviews/:reviewId/files/:fileId')
  async renewalReviewFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Param('reviewId') reviewId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.renewals.managementFile(
      user.id,
      caseId,
      requestId,
      reviewId,
      fileId,
    );
    this.sendStoredFile(response, file);
  }

  @Get(':caseId/renewal/:requestId')
  renewal(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.renewals.find(user.id, caseId, requestId);
  }

  @Post(':caseId/renewal')
  createRenewal(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.renewals.create(user.id, caseId);
  }

  @Post(':caseId/renewal/:requestId/continue')
  continueRenewal(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.renewals.continue(user.id, caseId, requestId);
  }

  @Post(':caseId/renewal/:requestId/documents')
  @UseInterceptors(upload)
  uploadRenewalDocument(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Body() dto: UploadPortalRenewalDocumentDto,
    @UploadedFile() file: UploadFile | undefined,
  ) {
    return this.renewals.upload(user.id, caseId, requestId, dto, file);
  }

  @Get(':caseId/location-change/:requestId/inquiries/:inquiryId/letter')
  locationInquiryLetter(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Param('inquiryId') inquiryId: string,
  ) {
    return this.letters.inquiryLetter(
      user.id,
      caseId,
      inquiryId,
      CaseRequestType.LOCATION_CHANGE,
      requestId,
    );
  }

  @Get(':caseId/location-change/:requestId/places/letter')
  locationPlacesLetter(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.letters.placesLetter(
      user.id,
      caseId,
      CaseRequestType.LOCATION_CHANGE,
      requestId,
    );
  }

  @Get(':caseId/location-change/:requestId/inquiries/:inquiryId/files/:fileId')
  async locationInquiryFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Param('inquiryId') inquiryId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.locations.inquiryFile(
      user.id,
      caseId,
      requestId,
      inquiryId,
      fileId,
    );
    this.sendStoredFile(response, file);
  }

  @Get(':caseId/location-change/:requestId/places/files/:fileId')
  async locationPlacesFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.locations.placesFile(user.id, caseId, requestId, fileId);
    this.sendStoredFile(response, file);
  }

  @Get(':caseId/location-change/:requestId/management-reviews/:reviewId/files/:fileId')
  async locationReviewFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Param('reviewId') reviewId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.locations.managementFile(
      user.id,
      caseId,
      requestId,
      reviewId,
      fileId,
    );
    this.sendStoredFile(response, file);
  }

  @Get(':caseId/location-change/:requestId')
  locationChange(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.locations.find(user.id, caseId, requestId);
  }

  @Post(':caseId/location-change')
  createLocationChange(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.locations.create(user.id, caseId);
  }

  @Patch(':caseId/location-change/:requestId/location')
  saveLocationChange(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Body() dto: SavePortalLocationDto,
  ) {
    return this.locations.saveLocation(user.id, caseId, requestId, dto);
  }

  @Post(':caseId/location-change/:requestId/continue')
  continueLocationChange(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.locations.continue(user.id, caseId, requestId);
  }

  @Post(':caseId/location-change/:requestId/documents')
  @UseInterceptors(upload)
  uploadLocationDocument(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
    @Body() dto: UploadPortalRenewalDocumentDto,
    @UploadedFile() file: UploadFile | undefined,
  ) {
    return this.locations.upload(user.id, caseId, requestId, dto, file);
  }

  private sendStoredFile(
    response: Response,
    file: {
      mimeType: string;
      originalName: string | null;
      data: Buffer;
    },
  ) {
    response.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    response.setHeader('Content-Length', String(file.data.length));
    response.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(file.originalName ?? 'file')}`,
    );
    response.send(file.data);
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

  @Get(':caseId/stewards')
  stewards(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.stewardshipPortal.list(user.id, caseId);
  }

  @Get(':caseId/stewards/lookup')
  lookupSteward(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Query() query: CreatePortalStewardDto,
  ) {
    return this.stewardshipPortal.lookup(user.id, caseId, query.nationalId);
  }

  @Post(':caseId/stewards')
  createSteward(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Body() dto: CreatePortalStewardDto,
  ) {
    return this.stewardshipPortal.create(user.id, caseId, dto.nationalId, dto.phone);
  }

  @Delete(':caseId/stewards/:stewardCaseId')
  cancelOpenSteward(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('stewardCaseId') stewardCaseId: string,
  ) {
    return this.stewardshipPortal.cancelOpen(user.id, caseId, stewardCaseId);
  }

  @Get(':caseId/stewardship')
  stewardship(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.cases.stewardship(user.id, caseId);
  }

  @Get(':caseId/stewardship/formation')
  getStewardFormation(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.stewardFormation.find(user.id, caseId);
  }

  @Patch(':caseId/stewardship/formation/identity')
  stewardFormationIdentity(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Body() dto: SavePortalStewardIdentityDto,
  ) {
    return this.stewardFormation.saveIdentity(user.id, caseId, dto);
  }

  @Post(':caseId/stewardship/formation/documents')
  @UseInterceptors(upload)
  stewardFormationDocument(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Body() dto: UploadPortalStewardDocumentDto,
    @UploadedFile() file: UploadFile | undefined,
  ) {
    return this.stewardFormation.upload(user.id, caseId, dto, file);
  }

  @Delete(':caseId/stewardship/formation/documents/:documentId')
  stewardFormationRemoveDocument(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.stewardFormation.removeDocument(user.id, caseId, documentId);
  }

  @Post(':caseId/stewardship/formation/continue')
  stewardFormationContinue(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
  ) {
    return this.stewardFormation.continue(user.id, caseId);
  }

  @Get(':caseId/stewardship/formation/inquiries/:inquiryId/letter')
  stewardFormationInquiryLetter(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('inquiryId') inquiryId: string,
  ) {
    return this.stewardFormation.find(user.id, caseId).then((state) =>
      this.letters.inquiryLetter(
        user.id,
        caseId,
        inquiryId,
        CaseRequestType.STEWARDSHIP,
        state.requestId,
      ),
    );
  }

  @Get(':caseId/stewardship/formation/places/letter')
  stewardFormationPlacesLetter(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
  ) {
    return this.stewardFormation.find(user.id, caseId).then((state) =>
      this.letters.placesLetter(
        user.id,
        caseId,
        CaseRequestType.STEWARDSHIP,
        state.requestId,
      ),
    );
  }

  @Get(':caseId/stewardship/formation/inquiries/:inquiryId/files/:fileId')
  async stewardFormationInquiryFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('inquiryId') inquiryId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.stewardFormation.inquiryFile(
      user.id,
      caseId,
      inquiryId,
      fileId,
    );
    this.sendStoredFile(response, file);
  }

  @Get(':caseId/stewardship/formation/places/files/:fileId')
  async stewardFormationPlacesFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.stewardFormation.placesFile(user.id, caseId, fileId);
    this.sendStoredFile(response, file);
  }

  @Get(':caseId/stewardship/formation/management-reviews/:reviewId/files/:fileId')
  async stewardFormationReviewFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('reviewId') reviewId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.stewardFormation.managementFile(
      user.id,
      caseId,
      reviewId,
      fileId,
    );
    this.sendStoredFile(response, file);
  }

  @Post(':caseId/stewardship/revocation')
  @UseInterceptors(upload)
  revokeStewardship(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Body() dto: RevokePortalStewardshipDto,
    @UploadedFile() file: UploadFile | undefined,
  ) {
    return this.cases.revokeStewardship(user.id, caseId, dto, file);
  }

  @Delete(':caseId/requests/:requestId')
  cancelRequest(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.cases.cancelRequest(user.id, caseId, requestId);
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
  imports: [SmsModule],
  controllers: [CasesController],
  providers: [
    CasesService,
    PortalAuctionService,
    PortalRenewalService,
    PortalLocationService,
    PortalLettersService,
    PortalStewardshipService,
    PortalStewardFormationService,
  ],
  exports: [CasesService],
})
export class CasesModule {}
