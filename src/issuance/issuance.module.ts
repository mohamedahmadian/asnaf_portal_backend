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
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CurrentUser, PortalUser } from '../auth/auth.module';
import { readStoredBytes } from '../storage/stored-file';
import {
  CaseFileKind,
  CaseRequestType,
  PremiseEstablishment,
  PremiseGeoPosition,
  PremiseOwnership,
  PremisePublicAccess,
  PreviousOccupation,
  UserGender,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PortalLettersService } from '../cases/portal-letters.service';

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

export class SaveIdentityDto {
  @IsString()
  @MinLength(1)
  firstName: string;

  @IsString()
  @MinLength(1)
  lastName: string;

  @IsOptional()
  @IsString()
  fatherName?: string;

  @IsOptional()
  @IsEnum(UserGender)
  gender?: UserGender;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  birthDate?: string;

  @IsOptional()
  @Matches(/^09\d{9}$/)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsOptional()
  @IsUUID()
  countryId?: string;
}

export class SaveActivityDto {
  @IsString()
  @MinLength(1)
  businessUnitTitle: string;

  @IsUUID()
  jobId: string;

  @IsOptional()
  @IsEnum(PreviousOccupation)
  previousOccupation?: PreviousOccupation;

  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value == null ? undefined : Number(value),
  )
  @IsInt()
  @Min(0)
  @Max(999)
  posDeviceCount?: number;
}

export class SaveLocationDto {
  @IsUUID()
  cityId: string;

  @IsEnum(PremiseEstablishment)
  establishment: PremiseEstablishment;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsUUID()
  complexId?: string;

  @IsString()
  @MinLength(3)
  address: string;

  @IsOptional()
  @IsString()
  addressEn?: string;

  @IsOptional()
  @IsString()
  plaque?: string;

  @IsOptional()
  @IsString()
  plaqueSeries?: string;

  @IsOptional()
  @IsString()
  floor?: string;

  @IsOptional()
  @IsString()
  unitNo?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  fax?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsEnum(PremiseGeoPosition)
  geoPosition?: PremiseGeoPosition;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsEnum(PremisePublicAccess)
  publicAccess?: PremisePublicAccess;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsUUID()
  registrationPlaceId?: string;

  @IsEnum(PremiseOwnership)
  ownership: PremiseOwnership;

  @IsOptional()
  @IsString()
  deedNo?: string;

  @Transform(({ value }) => Number(value))
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  area: number;

  @IsOptional()
  @ValidateIf((object) => object.ownership === PremiseOwnership.RENTED)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  leaseIssuedAt?: string;

  @IsOptional()
  @ValidateIf((object) => object.ownership === PremiseOwnership.RENTED)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  leaseExpiresAt?: string;

  @IsOptional()
  @IsString()
  leaseAgency?: string;

  @IsOptional()
  @IsString()
  ownerName?: string;
}

export class UploadDocumentDto {
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,64}$/)
  documentId: string;

  @IsString()
  @Matches(/^(identity|activity)$/)
  scope: 'identity' | 'activity';
}

function dateOnly(value: Date | null) {
  if (!value) return null;
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const caseSelect = {
  id: true,
  kind: true,
  formationStep: true,
  trackingCode: true,
  businessUnitTitle: true,
  activityJobId: true,
  licenseIssuedAt: true,
  licenseNumber: true,
  activityJob: {
    select: {
      id: true,
      title: true,
      groupId: true,
      group: { select: { id: true, title: true } },
      jobType: { select: { id: true, title: true } },
    },
  },
  previousOccupation: true,
  posDeviceCount: true,
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
} as const;

const identityUserSelect = {
  firstName: true,
  lastName: true,
  fullName: true,
  fatherName: true,
  lastNameEn: true,
  nationalId: true,
  gender: true,
  religion: true,
  religionOther: true,
  birthDate: true,
  birthPlace: true,
  identityCertificateNo: true,
  identityIssuedIn: true,
  country: { select: { id: true, nameFa: true } },
  residencyStatus: true,
  passportNumber: true,
  nationalCardExpiresAt: true,
  passportExpiresAt: true,
  phone: true,
  homePhone: true,
  email: true,
  address: true,
  postalCode: true,
  educationLevel: true,
  citizenGroup: true,
  economicJob: { select: { id: true, title: true } },
} as const;

const issuanceDocumentSelect = {
  id: true,
  documentId: true,
  document: { select: { title: true, code: true } },
  versions: {
    orderBy: { version: 'desc' as const },
    take: 1,
    select: {
      id: true,
      originalName: true,
      mimeType: true,
      byteSize: true,
      version: true,
    },
  },
} as const;

function emptyIssuanceFile() {
  return {
    id: '',
    kind: CaseFileKind.LICENSE,
    formationStep: 0,
    trackingCode: null,
    businessUnitTitle: null,
    activityJobId: null,
    licenseIssuedAt: null,
    licenseNumber: null,
    activityJob: null,
    previousOccupation: null,
    posDeviceCount: null,
    premiseCityId: null,
    premiseEstablishment: null,
    premiseComplexId: null,
    premiseAddress: null,
    premiseAddressEn: null,
    premisePlaque: null,
    premisePlaqueSeries: null,
    premiseFloor: null,
    premiseUnitNo: null,
    premisePostalCode: null,
    premisePhone: null,
    premiseFax: null,
    premiseGeoPosition: null,
    premisePublicAccess: null,
    registrationPlaceId: null,
    premiseOwnership: null,
    premiseDeedNo: null,
    premiseArea: null,
    leaseIssuedAt: null,
    leaseExpiresAt: null,
    leaseAgency: null,
    premiseOwnerName: null,
  };
}

function emptyIssuanceRequest() {
  return {
    id: '',
    number: '',
    status: 'OPEN',
    formationStep: 0,
    intakeSubmittedAt: null,
    createdAt: new Date(0),
  };
}

@Injectable()
export class IssuanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async start(userId: string) {
    const existing = await this.findOpenIssuance(userId);
    if (existing) return this.state(userId, existing.id);
    const created = await this.createOpenIssuance(userId, 0);
    return this.state(userId, created.id);
  }

  async draft(userId: string) {
    const existing = await this.findOpenIssuance(userId);
    if (existing) return this.state(userId, existing.id);
    return this.previewState(userId);
  }

  async confirmDraft(userId: string) {
    const existing = await this.findOpenIssuance(userId);
    if (existing) return this.confirmIdentity(userId, existing.id);
    await this.assertIdentityReady(userId);
    const created = await this.createOpenIssuance(userId, 1);
    return this.state(userId, created.id);
  }

  async state(userId: string, caseId: string) {
    const file = await this.ownedCase(userId, caseId);
    const [user, request, identityDocuments, activityDocuments] =
      await Promise.all([
        this.prisma.user.findUniqueOrThrow({
          where: { id: userId },
          select: identityUserSelect,
        }),
        this.issuanceRequest(caseId),
        this.prisma.personDocument.findMany({
          where: { userId },
          select: issuanceDocumentSelect,
        }),
        this.prisma.caseActivityDocument.findMany({
          where: { caseFileId: caseId },
          select: issuanceDocumentSelect,
        }),
      ]);
    return {
      case: file,
      identity: this.identityView(user),
      request,
      documents: { identity: identityDocuments, activity: activityDocuments },
      editable:
        file.formationStep < 3 &&
        request.status === 'OPEN' &&
        !request.intakeSubmittedAt,
      awaitingIntake: Boolean(request.intakeSubmittedAt) && file.formationStep < 3,
      steps: this.stepModes(file.formationStep, Boolean(request.intakeSubmittedAt)),
    };
  }

  async confirmIdentity(userId: string, caseId: string) {
    const file = await this.mutableCase(userId, caseId);
    await this.assertIdentityReady(userId);
    if (file.formationStep < 1) {
      const request = await this.issuanceRequest(caseId);
      await this.prisma.$transaction([
        this.prisma.caseFile.update({
          where: { id: file.id },
          data: { formationStep: 1 },
        }),
        this.prisma.caseRequest.update({
          where: { id: request.id },
          data: { formationStep: Math.max(request.formationStep, 1) },
        }),
      ]);
    }
    return this.state(userId, caseId);
  }

  async saveIdentity(userId: string, caseId: string, dto: SaveIdentityDto) {
    const file = await this.mutableCase(userId, caseId);
    if (dto.countryId) {
      const country = await this.prisma.country.findFirst({
        where: { id: dto.countryId, isActive: true },
        select: { id: true },
      });
      if (!country) throw new BadRequestException('ملیت معتبر نیست');
    }
    const phone = dto.phone?.trim();
    if (phone) {
      const duplicate = await this.prisma.user.findFirst({
        where: { phone, id: { not: userId } },
        select: { id: true },
      });
      if (duplicate)
        throw new BadRequestException('این تلفن همراه قبلاً ثبت شده است');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          fullName: `${dto.firstName.trim()} ${dto.lastName.trim()}`,
          fatherName: dto.fatherName?.trim() || null,
          gender: dto.gender ?? null,
          birthDate: dto.birthDate
            ? new Date(`${dto.birthDate}T00:00:00.000Z`)
            : null,
          phone: phone || null,
          email: dto.email?.trim().toLowerCase() || null,
          address: dto.address?.trim() || null,
          postalCode: dto.postalCode?.replace(/\D/g, '') || null,
          countryId: dto.countryId ?? null,
        },
      }),
      this.prisma.caseFile.update({
        where: { id: file.id },
        data: { formationStep: Math.max(file.formationStep, 1) },
      }),
      this.prisma.caseRequest.update({
        where: { id: (await this.issuanceRequest(caseId)).id },
        data: { formationStep: Math.max(file.formationStep, 1) },
      }),
    ]);
    return this.state(userId, caseId);
  }

  async saveActivity(userId: string, caseId: string, dto: SaveActivityDto) {
    const file = await this.mutableCase(userId, caseId);
    if (file.formationStep < 1)
      throw new BadRequestException('ابتدا اطلاعات هویتی را تکمیل کنید');
    const job = await this.prisma.job.findFirst({
      where: { id: dto.jobId, isActive: true },
      select: { id: true },
    });
    if (!job) throw new BadRequestException('شغل معتبر نیست');
    if (await this.missingRequiredActivityDocuments(userId, caseId, job.id)) {
      throw new BadRequestException('مدارک الزامی شغل بارگذاری نشده است');
    }
    const request = await this.issuanceRequest(caseId);
    await this.prisma.$transaction([
      this.prisma.caseFile.update({
        where: { id: caseId },
        data: {
          businessUnitTitle: dto.businessUnitTitle.trim(),
          activityJobId: job.id,
          previousOccupation: dto.previousOccupation ?? null,
          posDeviceCount: dto.posDeviceCount ?? null,
          formationStep: Math.max(file.formationStep, 2),
        },
      }),
      this.prisma.caseRequest.update({
        where: { id: request.id },
        data: { formationStep: Math.max(file.formationStep, 2) },
      }),
    ]);
    return this.state(userId, caseId);
  }

  async saveLocation(userId: string, caseId: string, dto: SaveLocationDto) {
    const file = await this.mutableCase(userId, caseId);
    if (file.formationStep < 2)
      throw new BadRequestException('ابتدا حوزه فعالیت را تکمیل کنید');
    const city = await this.prisma.city.findFirst({
      where: { id: dto.cityId, isActive: true },
      select: { id: true },
    });
    if (!city) throw new BadRequestException('شهر معتبر نیست');
    const complexId =
      dto.establishment === 'COMMERCIAL_COMPLEX' ? (dto.complexId ?? null) : null;
    if (dto.establishment === 'COMMERCIAL_COMPLEX' && !complexId) {
      throw new BadRequestException('مجتمع را انتخاب کنید');
    }
    if (complexId) {
      const complex = await this.prisma.commercialComplex.findFirst({
        where: { id: complexId, isActive: true },
        select: { id: true },
      });
      if (!complex) throw new BadRequestException('مجتمع معتبر نیست');
    }
    const registrationPlaceId = await this.resolveRegistrationPlace(file.registrationPlaceId);
    const rented = dto.ownership === 'RENTED';
    const digits = (value?: string) => value?.replace(/\D/g, '') || null;
    const request = await this.issuanceRequest(caseId);
    await this.prisma.$transaction([
      this.prisma.caseFile.update({
        where: { id: caseId },
        data: {
          premiseCityId: dto.cityId,
          premiseEstablishment: dto.establishment,
          premiseComplexId: complexId,
          premiseAddress: dto.address.trim(),
          premiseAddressEn: dto.addressEn?.trim() || null,
          premisePlaque: dto.plaque?.trim() || null,
          premisePlaqueSeries: dto.plaqueSeries?.trim() || null,
          premiseFloor: dto.floor?.trim() || null,
          premiseUnitNo: dto.unitNo?.trim() || null,
          premisePostalCode: digits(dto.postalCode),
          premisePhone: digits(dto.phone),
          premiseFax: digits(dto.fax),
          premiseGeoPosition: dto.geoPosition ?? null,
          premisePublicAccess: dto.publicAccess ?? null,
          registrationPlaceId,
          premiseOwnership: dto.ownership,
          premiseDeedNo: dto.deedNo?.trim() || null,
          premiseArea: dto.area,
          leaseIssuedAt:
            rented && dto.leaseIssuedAt
              ? new Date(`${dto.leaseIssuedAt}T00:00:00.000Z`)
              : null,
          leaseExpiresAt:
            rented && dto.leaseExpiresAt
              ? new Date(`${dto.leaseExpiresAt}T00:00:00.000Z`)
              : null,
          leaseAgency: rented ? dto.leaseAgency?.trim() || null : null,
          premiseOwnerName: rented ? dto.ownerName?.trim() || null : null,
          formationStep: Math.max(file.formationStep, 2),
        },
      }),
      this.prisma.caseRequest.update({
        where: { id: request.id },
        data: { formationStep: Math.max(file.formationStep, 2) },
      }),
    ]);
    return this.state(userId, caseId);
  }

  async requirements(userId: string, caseId?: string | null, jobId?: string) {
    const file = caseId ? await this.ownedCase(userId, caseId) : null;
    const requestedJobId = jobId?.trim();
    if (
      requestedJobId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        requestedJobId,
      )
    ) {
      throw new BadRequestException('شغل معتبر نیست');
    }
    if (requestedJobId) {
      const job = await this.prisma.job.findFirst({
        where: { id: requestedJobId, isActive: true },
        select: { id: true },
      });
      if (!job) throw new BadRequestException('شغل معتبر نیست');
    }
    const activityJobId = requestedJobId || file?.activityJobId;
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { gender: true },
    });
    const identity = await this.prisma.caseIdentityDocument.findMany({
      where: {
        OR: [
          { gender: 'BOTH' },
          ...(user.gender ? [{ gender: user.gender }] : []),
        ],
      },
      select: {
        isRequired: true,
        document: { select: { id: true, code: true, title: true } },
      },
      orderBy: { document: { title: 'asc' } },
    });
    const activity = await this.prisma.documentRequirement.findMany({
      where: {
        requestType: CaseRequestType.ISSUANCE,
        OR: [
          { jobId: null },
          ...(activityJobId ? [{ jobId: activityJobId }] : []),
        ],
        AND: [
          {
            OR: [
              { gender: 'BOTH' },
              ...(user.gender ? [{ gender: user.gender }] : []),
            ],
          },
        ],
      },
      select: {
        isRequired: true,
        document: { select: { id: true, code: true, title: true } },
      },
      orderBy: { document: { title: 'asc' } },
    });
    return { identity, activity };
  }

  async upload(
    userId: string,
    caseId: string | null,
    dto: UploadDocumentDto,
    file: UploadFile | undefined,
  ) {
    const owned = caseId ? await this.mutableCase(userId, caseId) : null;
    if (!owned && dto.scope !== 'identity') {
      throw new BadRequestException('ابتدا تب هویت را تکمیل کنید');
    }
    if (!file?.buffer || file.size <= 0)
      throw new BadRequestException('فایل را انتخاب کنید');
    if (
      !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(
        file.mimetype,
      )
    ) {
      throw new BadRequestException('نوع فایل مجاز نیست');
    }
    const document = await this.prisma.document.findUnique({
      where: { id: dto.documentId },
      select: { id: true },
    });
    if (!document) throw new BadRequestException('نوع مدرک معتبر نیست');
    const request = owned ? await this.issuanceRequest(owned.id) : null;
    const documentId =
      dto.scope === 'identity'
        ? (
            await this.prisma.personDocument.upsert({
              where: {
                userId_documentId: { userId, documentId: dto.documentId },
              },
              create: { userId, documentId: dto.documentId },
              update: {},
              select: { id: true },
            })
          ).id
        : (
            await this.prisma.caseActivityDocument.upsert({
              where: {
                caseRequestId_documentId: {
                  caseRequestId: request!.id,
                  documentId: dto.documentId,
                },
              },
              create: {
                caseFileId: owned!.id,
                caseRequestId: request!.id,
                documentId: dto.documentId,
              },
              update: {},
              select: { id: true },
            })
          ).id;
    const version =
      1 +
      (dto.scope === 'identity'
        ? await this.prisma.personDocumentVersion.count({
            where: { personDocumentId: documentId },
          })
        : await this.prisma.caseActivityDocumentVersion.count({
            where: { caseActivityDocumentId: documentId },
          }));
    const extension =
      file.mimetype === 'application/pdf'
        ? '.pdf'
        : file.mimetype === 'image/png'
          ? '.png'
          : file.mimetype === 'image/webp'
            ? '.webp'
            : '.jpg';
    const storageKey =
      dto.scope === 'identity'
        ? `persons/${userId}/documents/${documentId}/v${version}${extension}`
        : `persons/${userId}/cases/${owned!.id}/documents/${documentId}/v${version}${extension}`;
    const root = path.resolve(this.config.getOrThrow<string>('storage.root'));
    const absolute = path.resolve(root, storageKey);
    if (!absolute.startsWith(`${root}${path.sep}`))
      throw new BadRequestException('مسیر فایل معتبر نیست');
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.buffer, { flag: 'wx' });
    try {
      if (dto.scope === 'identity') {
        await this.prisma.personDocumentVersion.create({
          data: {
            personDocumentId: documentId,
            version,
            storageKey,
            originalName: file.originalname,
            mimeType: file.mimetype,
            byteSize: file.size,
          },
        });
      } else {
        await this.prisma.caseActivityDocumentVersion.create({
          data: {
            caseActivityDocumentId: documentId,
            version,
            storageKey,
            originalName: file.originalname,
            mimeType: file.mimetype,
            byteSize: file.size,
          },
        });
      }
    } catch (error) {
      await unlink(absolute).catch(() => undefined);
      throw error;
    }
    return owned ? this.state(userId, owned.id) : this.previewState(userId);
  }

  async removeDocument(
    userId: string,
    caseId: string | null,
    documentId: string,
    scope: string,
  ) {
    if (caseId) await this.mutableCase(userId, caseId);
    else if (scope !== 'identity') {
      throw new BadRequestException('ابتدا تب هویت را تکمیل کنید');
    }
    const request = caseId ? await this.issuanceRequest(caseId) : null;
    if (scope === 'identity') {
      const row = await this.prisma.personDocument.findFirst({
        where: { userId, documentId },
        select: { id: true },
      });
      if (!row) throw new NotFoundException('مدرک یافت نشد');
      await this.prisma.personDocument.delete({ where: { id: row.id } });
    } else if (scope === 'activity') {
      const row = await this.prisma.caseActivityDocument.findFirst({
        where: { caseRequestId: request!.id, documentId, caseFile: { userId } },
        select: { id: true },
      });
      if (!row) throw new NotFoundException('مدرک یافت نشد');
      await this.prisma.caseActivityDocument.delete({ where: { id: row.id } });
    } else {
      throw new BadRequestException('دامنه مدرک معتبر نیست');
    }
    return { removed: true };
  }

  async submit(userId: string, caseId: string) {
    const file = await this.mutableCase(userId, caseId);
    if (
      file.formationStep < 2 ||
      !file.activityJobId ||
      !file.premiseCityId ||
      !file.premiseAddress ||
      !file.premiseOwnership
    ) {
      throw new BadRequestException('اطلاعات پرونده کامل نیست');
    }
    const request = await this.issuanceRequest(caseId);
    const requirements = await this.requirements(userId, caseId);
    const [identityStored, activityStored] = await Promise.all([
      this.prisma.personDocument.findMany({
        where: { userId, versions: { some: {} } },
        select: { documentId: true },
      }),
      this.prisma.caseActivityDocument.findMany({
        where: { caseRequestId: request.id, versions: { some: {} } },
        select: { documentId: true },
      }),
    ]);
    const identityIds = new Set(identityStored.map((item) => item.documentId));
    const activityIds = new Set(activityStored.map((item) => item.documentId));
    if (
      requirements.identity.some(
        (item) => item.isRequired && !identityIds.has(item.document.id),
      ) ||
      requirements.activity.some(
        (item) => item.isRequired && !activityIds.has(item.document.id),
      )
    ) {
      throw new BadRequestException('مدارک الزامی کامل نیست');
    }
    const submittedAt = new Date();
    await this.prisma.caseRequest.update({
      where: { id: request.id },
      data: { intakeSubmittedAt: submittedAt },
    });
    const saved = await this.state(userId, caseId);
    return {
      ...saved,
      receipt: {
        jobTitle: saved.case.activityJob?.title ?? '',
        jobGroup: saved.case.activityJob?.group?.title ?? '',
        unitTitle: saved.case.businessUnitTitle ?? '',
        requestNumber: saved.request.number,
        submittedAt: submittedAt.toISOString(),
      },
    };
  }

  async organizationSteps(userId: string, caseId: string) {
    await this.ownedCase(userId, caseId);
    const request = await this.issuanceRequest(caseId);
    const row = await this.prisma.caseRequest.findFirstOrThrow({
      where: { id: request.id, caseFile: { userId } },
      select: {
        id: true,
        number: true,
        status: true,
        formationStep: true,
        inquiries: {
          orderBy: [{ referredAt: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            status: true,
            note: true,
            referredAt: true,
            decidedAt: true,
            inquiryCenter: { select: { name: true } },
            decidedBy: { select: { fullName: true } },
            files: {
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                originalName: true,
                mimeType: true,
                byteSize: true,
              },
            },
          },
        },
        placesReview: {
          select: {
            id: true,
            status: true,
            note: true,
            referredAt: true,
            decidedAt: true,
            decidedBy: { select: { fullName: true } },
            files: {
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                originalName: true,
                mimeType: true,
                byteSize: true,
              },
            },
          },
        },
        managementReviews: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            status: true,
            note: true,
            createdAt: true,
            decidedAt: true,
            decidedBy: { select: { fullName: true } },
            role: { select: { id: true, name: true } },
            workUnit: { select: { title: true } },
            files: {
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                originalName: true,
                mimeType: true,
                byteSize: true,
              },
            },
          },
        },
        caseFile: {
          select: {
            licenseNumber: true,
            licenseIssuedAt: true,
            licenseExpiresAt: true,
          },
        },
      },
    });
    const titles = row.managementReviews.length
      ? await this.prisma.caseProcessManagementRole.findMany({
          where: {
            requestType: 'ISSUANCE',
            roleId: { in: row.managementReviews.map((item) => item.role.id) },
          },
          select: { roleId: true, title: true },
        })
      : [];
    return {
      ...row,
      managementReviews: row.managementReviews.map((item) => ({
        id: item.id,
        status: item.status,
        referredAt: item.createdAt,
        decidedAt: item.decidedAt,
        decidedBy: item.decidedBy,
        title:
          titles.find((role) => role.roleId === item.role.id)?.title ??
          [item.workUnit?.title, item.role.name].filter(Boolean).join(' · '),
        files: item.files,
      })),
    };
  }

  async inquiryFile(
    userId: string,
    caseId: string,
    inquiryId: string,
    fileId: string,
  ) {
    const file = await this.prisma.caseInquiryFile.findFirst({
      where: {
        id: fileId,
        caseInquiryId: inquiryId,
        caseInquiry: {
          caseFileId: caseId,
          caseFile: { userId },
          caseRequest: { type: 'ISSUANCE' },
        },
      },
      select: {
        storageKey: true,
        originalName: true,
        mimeType: true,
        byteSize: true,
      },
    });
    return this.readableStoredFile(file);
  }

  async placesFile(userId: string, caseId: string, fileId: string) {
    const file = await this.prisma.casePlacesFile.findFirst({
      where: {
        id: fileId,
        review: {
          caseFileId: caseId,
          caseFile: { userId },
          caseRequest: { type: 'ISSUANCE' },
        },
      },
      select: {
        storageKey: true,
        originalName: true,
        mimeType: true,
        byteSize: true,
      },
    });
    return this.readableStoredFile(file);
  }

  async managementFile(
    userId: string,
    caseId: string,
    reviewId: string,
    fileId: string,
  ) {
    const file = await this.prisma.caseManagementReviewFile.findFirst({
      where: {
        id: fileId,
        reviewId,
        review: {
          caseFileId: caseId,
          caseFile: { userId },
          caseRequest: { type: 'ISSUANCE' },
        },
      },
      select: {
        storageKey: true,
        originalName: true,
        mimeType: true,
        byteSize: true,
      },
    });
    return this.readableStoredFile(file);
  }

  private async readableStoredFile(
    file: {
      storageKey: string;
      originalName: string | null;
      mimeType: string;
      byteSize: number;
    } | null,
  ) {
    if (!file) throw new NotFoundException('پیوست یافت نشد');
    const data = await readStoredBytes(
      file.storageKey,
      this.config.getOrThrow<string>('storage.root'),
    );
    return { ...file, data };
  }

  private stepModes(step: number, awaitingIntake = false) {
    return [0, 1, 2, 3, 4, 5, 6].map((index) => ({
      step: index,
      mode:
        index < 3
          ? step < 3 && !awaitingIntake
            ? 'EDIT'
            : 'LOCKED'
          : index <= step
            ? 'VIEW'
            : 'LOCKED',
    }));
  }

  private async missingRequiredActivityDocuments(
    userId: string,
    caseId: string,
    jobId: string,
  ) {
    const requirements = await this.requirements(userId, caseId, jobId);
    const request = await this.issuanceRequest(caseId);
    const stored = await this.prisma.caseActivityDocument.findMany({
      where: { caseRequestId: request.id, versions: { some: {} } },
      select: { documentId: true },
    });
    const uploaded = new Set(stored.map((item) => item.documentId));
    return requirements.activity.some(
      (item) => item.isRequired && !uploaded.has(item.document.id),
    );
  }

  private async findOpenIssuance(userId: string) {
    return this.prisma.caseFile.findFirst({
      where: {
        userId,
        kind: 'LICENSE',
        licenseNumber: null,
        requests: { some: { type: 'ISSUANCE', status: 'OPEN' } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
  }

  private async createOpenIssuance(userId: string, formationStep: number) {
    const sequence = (await this.prisma.caseRequest.count()) + 1;
    const year = new Date().getUTCFullYear();
    const trackingCode = `CASE-${year}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const number = `REQ-${year}-${String(sequence).padStart(7, '0')}`;
    return this.prisma.caseFile.create({
      data: {
        userId,
        formationStep,
        trackingCode,
        requests: {
          create: {
            type: 'ISSUANCE',
            number,
            status: 'OPEN',
            formationStep,
          },
        },
      },
      select: { id: true },
    });
  }

  private async assertIdentityReady(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { nationalId: true, firstName: true, lastName: true },
    });
    if (!user.nationalId?.trim() || !user.firstName.trim() || !user.lastName.trim()) {
      throw new BadRequestException('اطلاعات هویتی بر اساس کد ملی کامل نیست');
    }
  }

  private async previewState(userId: string) {
    const [user, identityDocuments] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: identityUserSelect,
      }),
      this.prisma.personDocument.findMany({
        where: { userId },
        select: issuanceDocumentSelect,
      }),
    ]);
    return {
      case: emptyIssuanceFile(),
      identity: this.identityView(user),
      request: emptyIssuanceRequest(),
      documents: { identity: identityDocuments, activity: [] },
      editable: true,
      awaitingIntake: false,
      steps: this.stepModes(0),
    };
  }

  private async ownedCase(userId: string, caseId: string) {
    const row = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId },
      select: caseSelect,
    });
    if (!row) throw new NotFoundException('پرونده یافت نشد');
    if (row.kind === CaseFileKind.STEWARDSHIP) {
      throw new BadRequestException(
        'پرونده مباشرت از مسیر صدور مجوز تکمیل نمی‌شود',
      );
    }
    return row;
  }

  private async mutableCase(userId: string, caseId: string) {
    const row = await this.ownedCase(userId, caseId);
    const request = await this.issuanceRequest(caseId);
    if (
      row.formationStep >= 3 ||
      request.status !== 'OPEN' ||
      request.intakeSubmittedAt
    ) {
      throw new BadRequestException('پرونده پس از ثبت اولیه قابل ویرایش نیست');
    }
    return row;
  }

  private async resolveRegistrationPlace(currentId: string | null) {
    if (currentId) return currentId;
    const place = await this.prisma.registrationPlace.findFirst({
      where: { isActive: true, isDefault: true },
      select: { id: true },
    });
    return place?.id ?? null;
  }

  private identityView(user: {
    firstName: string;
    lastName: string;
    fullName: string;
    fatherName: string | null;
    lastNameEn: string | null;
    nationalId: string | null;
    gender: string | null;
    religion: string | null;
    religionOther: string | null;
    birthDate: Date | null;
    birthPlace: string | null;
    identityCertificateNo: string | null;
    identityIssuedIn: string | null;
    country: { id: string; nameFa: string } | null;
    residencyStatus: string | null;
    passportNumber: string | null;
    nationalCardExpiresAt: Date | null;
    passportExpiresAt: Date | null;
    phone: string | null;
    homePhone: string | null;
    email: string | null;
    address: string | null;
    postalCode: string | null;
    educationLevel: string | null;
    citizenGroup: string | null;
    economicJob: { id: string; title: string } | null;
  }) {
    return {
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: user.fullName,
      fatherName: user.fatherName,
      lastNameEn: user.lastNameEn,
      nationalId: user.nationalId,
      gender: user.gender,
      religion: user.religion,
      religionOther: user.religionOther,
      birthDate: dateOnly(user.birthDate),
      birthPlace: user.birthPlace,
      identityCertificateNo: user.identityCertificateNo,
      identityIssuedIn: user.identityIssuedIn,
      countryId: user.country?.id ?? null,
      countryName: user.country?.nameFa ?? null,
      residencyStatus: user.residencyStatus,
      passportNumber: user.passportNumber,
      nationalCardExpiresAt: dateOnly(user.nationalCardExpiresAt),
      passportExpiresAt: dateOnly(user.passportExpiresAt),
      phone: user.phone,
      homePhone: user.homePhone,
      email: user.email,
      address: user.address,
      postalCode: user.postalCode,
      educationLevel: user.educationLevel,
      citizenGroup: user.citizenGroup,
      jobTitle: user.economicJob?.title ?? null,
    };
  }

  private async issuanceRequest(caseId: string) {
    const request = await this.prisma.caseRequest.findFirst({
      where: { caseFileId: caseId, type: 'ISSUANCE' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        number: true,
        status: true,
        formationStep: true,
        intakeSubmittedAt: true,
        createdAt: true,
      },
    });
    if (!request) throw new NotFoundException('درخواست صدور یافت نشد');
    return request;
  }
}

@Controller('issuance')
export class IssuanceController {
  constructor(
    private readonly issuance: IssuanceService,
    private readonly letters: PortalLettersService,
  ) {}

  @Post()
  start(@CurrentUser() user: PortalUser) {
    return this.issuance.start(user.id);
  }

  @Get('draft')
  draft(@CurrentUser() user: PortalUser) {
    return this.issuance.draft(user.id);
  }

  @Get('draft/requirements')
  draftRequirements(@CurrentUser() user: PortalUser, @Query('jobId') jobId?: string) {
    return this.issuance.requirements(user.id, null, jobId);
  }

  @Post('draft/documents')
  @UseInterceptors(upload)
  draftDocument(
    @CurrentUser() user: PortalUser,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file: UploadFile | undefined,
  ) {
    return this.issuance.upload(user.id, null, dto, file);
  }

  @Delete('draft/documents/:scope/:documentId')
  removeDraftDocument(
    @CurrentUser() user: PortalUser,
    @Param('scope') scope: string,
    @Param('documentId') documentId: string,
  ) {
    return this.issuance.removeDocument(user.id, null, documentId, scope);
  }

  @Post('draft/identity/confirm')
  confirmDraft(@CurrentUser() user: PortalUser) {
    return this.issuance.confirmDraft(user.id);
  }

  @Get(':caseId')
  state(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.issuance.state(user.id, caseId);
  }

  @Patch(':caseId/identity')
  identity(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Body() dto: SaveIdentityDto,
  ) {
    return this.issuance.saveIdentity(user.id, caseId, dto);
  }

  @Patch(':caseId/activity')
  activity(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Body() dto: SaveActivityDto,
  ) {
    return this.issuance.saveActivity(user.id, caseId, dto);
  }

  @Patch(':caseId/location')
  location(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Body() dto: SaveLocationDto,
  ) {
    return this.issuance.saveLocation(user.id, caseId, dto);
  }

  @Get(':caseId/requirements')
  requirements(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Query('jobId') jobId?: string,
  ) {
    return this.issuance.requirements(user.id, caseId, jobId);
  }

  @Post(':caseId/documents')
  @UseInterceptors(upload)
  document(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file: UploadFile | undefined,
  ) {
    return this.issuance.upload(user.id, caseId, dto, file);
  }

  @Delete(':caseId/documents/:scope/:documentId')
  removeDocument(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('scope') scope: string,
    @Param('documentId') documentId: string,
  ) {
    return this.issuance.removeDocument(user.id, caseId, documentId, scope);
  }

  @Post(':caseId/identity/confirm')
  confirmIdentity(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
  ) {
    return this.issuance.confirmIdentity(user.id, caseId);
  }

  @Post(':caseId/submit')
  submit(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.issuance.submit(user.id, caseId);
  }

  @Get(':caseId/organization-steps')
  organizationSteps(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
  ) {
    return this.issuance.organizationSteps(user.id, caseId);
  }

  @Get(':caseId/inquiries/:inquiryId/letter')
  inquiryLetter(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('inquiryId') inquiryId: string,
  ) {
    return this.letters.inquiryLetter(user.id, caseId, inquiryId, CaseRequestType.ISSUANCE);
  }

  @Get(':caseId/places/letter')
  placesLetter(@CurrentUser() user: PortalUser, @Param('caseId') caseId: string) {
    return this.letters.placesLetter(user.id, caseId, CaseRequestType.ISSUANCE);
  }

  @Get(':caseId/inquiries/:inquiryId/files/:fileId')
  async inquiryFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('inquiryId') inquiryId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.issuance.inquiryFile(
      user.id,
      caseId,
      inquiryId,
      fileId,
    );
    this.sendStoredFile(response, file);
  }

  @Get(':caseId/places/files/:fileId')
  async placesFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.issuance.placesFile(user.id, caseId, fileId);
    this.sendStoredFile(response, file);
  }

  @Get(':caseId/management-reviews/:reviewId/files/:fileId')
  async managementFile(
    @CurrentUser() user: PortalUser,
    @Param('caseId') caseId: string,
    @Param('reviewId') reviewId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.issuance.managementFile(
      user.id,
      caseId,
      reviewId,
      fileId,
    );
    this.sendStoredFile(response, file);
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
}

@Module({
  controllers: [IssuanceController],
  providers: [IssuanceService, PortalLettersService],
  exports: [IssuanceService],
})
export class IssuanceModule {}
