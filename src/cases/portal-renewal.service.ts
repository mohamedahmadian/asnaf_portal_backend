import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString, Matches } from 'class-validator';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  CaseFileKind,
  CaseFileStatus,
  CaseRequestStatus,
  CaseRequestType,
  DocumentGender,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { readStoredBytes } from '../storage/stored-file';

type Db = PrismaService | Prisma.TransactionClient;

type UploadFile = {
  buffer: Buffer;
  size: number;
  mimetype: string;
  originalname: string;
};

export class UploadPortalRenewalDocumentDto {
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,64}$/)
  documentId: string;
}

const PERSONNEL_PHOTO_CODE = 'PERSONNEL_PHOTO';
const CONTRACT_DURATION_MIN = 1;
const CONTRACT_DURATION_MAX = 5;
const ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];

const reviewFileSelect = {
  id: true,
  originalName: true,
  mimeType: true,
  byteSize: true,
} as const;

function clampContractYears(value: unknown) {
  const years = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(years)) return CONTRACT_DURATION_MIN;
  return Math.min(CONTRACT_DURATION_MAX, Math.max(CONTRACT_DURATION_MIN, years));
}

function utcDateOnly(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function addUtcYears(date: Date, years: number) {
  return new Date(
    Date.UTC(
      date.getUTCFullYear() + years,
      date.getUTCMonth(),
      date.getUTCDate(),
    ),
  );
}

function dateOnly(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function jalaliYear(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (month < 3 || (month === 3 && day < 21)) return year - 622;
  return year - 621;
}

function isUniqueConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
}

function matchesDocumentGender(
  gender: DocumentGender,
  personGender: 'MALE' | 'FEMALE' | null,
) {
  return gender === DocumentGender.BOTH || !personGender || gender === personGender;
}

function renewalTermsFor(
  currentIssuedAt: Date,
  currentExpiresAt: Date,
  today = new Date(),
  years = 1,
) {
  const opened = utcDateOnly(today);
  const currentExpiry = utcDateOnly(currentExpiresAt);
  const delayDays = Math.floor(
    (opened.getTime() - currentExpiry.getTime()) / 86_400_000,
  );
  return {
    currentIssuedAt: utcDateOnly(currentIssuedAt),
    currentExpiresAt: currentExpiry,
    nextIssuedAt: currentExpiry,
    nextExpiresAt: addUtcYears(currentExpiry, clampContractYears(years)),
    delayDays: delayDays > 0 ? delayDays : 0,
  };
}

async function readContractYears(prisma: Db) {
  const row = await prisma.caseGeneralSettings.findUnique({
    where: { id: 'default' },
    select: { contractYears: true },
  });
  return clampContractYears(row?.contractYears);
}

async function nextRequestNumber(prisma: Db) {
  const prefix = `REQ-${jalaliYear()}-`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const count = await prisma.caseRequest.count({
      where: { number: { startsWith: prefix } },
    });
    const number = `${prefix}${String(count + 1 + attempt).padStart(6, '0')}`;
    const taken = await prisma.caseRequest.findUnique({
      where: { number },
      select: { id: true },
    });
    if (!taken) return number;
  }
  throw new ConflictException('صدور شماره درخواست انجام نشد');
}

async function resolveDocumentRequirements(
  prisma: Db,
  jobId: string | null,
  personGender: 'MALE' | 'FEMALE' | null,
) {
  const rows = await prisma.documentRequirement.findMany({
    where: {
      requestType: CaseRequestType.RENEWAL,
      OR: [{ jobId: null }, ...(jobId ? [{ jobId }] : [])],
    },
    select: {
      gender: true,
      isRequired: true,
      document: { select: { id: true, code: true, title: true } },
    },
  });
  const byId = new Map<
    string,
    { id: string; code: string | null; title: string; isRequired: boolean }
  >();
  for (const row of rows) {
    if (row.document.code === PERSONNEL_PHOTO_CODE) continue;
    if (!matchesDocumentGender(row.gender, personGender)) continue;
    const current = byId.get(row.document.id);
    if (!current) {
      byId.set(row.document.id, {
        id: row.document.id,
        code: row.document.code,
        title: row.document.title,
        isRequired: row.isRequired,
      });
      continue;
    }
    if (row.isRequired) current.isRequired = true;
  }
  return [...byId.values()].sort((left, right) =>
    left.title.localeCompare(right.title, 'fa'),
  );
}

@Injectable()
export class PortalRenewalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async find(userId: string, caseId: string, requestId: string) {
    await this.ownedCase(userId, caseId);
    return this.present(userId, caseId, requestId);
  }

  async create(userId: string, caseId: string) {
    const file = await this.ownedCase(userId, caseId);
    this.assertCanStart(file);
    const open = await this.prisma.caseRequest.findFirst({
      where: { caseFileId: file.id, status: CaseRequestStatus.OPEN },
      select: { id: true, type: true },
    });
    if (open?.type === CaseRequestType.RENEWAL) {
      return this.present(userId, file.id, open.id);
    }
    if (open) throw new BadRequestException('یک درخواست باز روی این پرونده وجود دارد');
    const contractYears = await readContractYears(this.prisma);
    for (let attempt = 0; attempt < 4; attempt++) {
      const number = await nextRequestNumber(this.prisma);
      try {
        const requestId = await this.prisma.$transaction(async (tx) => {
          const again = await tx.caseRequest.findFirst({
            where: { caseFileId: file.id, status: CaseRequestStatus.OPEN },
            select: { id: true, type: true },
          });
          if (again?.type === CaseRequestType.RENEWAL) return again.id;
          if (again) {
            throw new BadRequestException('یک درخواست باز روی این پرونده وجود دارد');
          }
          const request = await tx.caseRequest.create({
            data: {
              caseFileId: file.id,
              type: CaseRequestType.RENEWAL,
              number,
              status: CaseRequestStatus.OPEN,
              formationStep: 0,
              renewalTerms: {
                create: renewalTermsFor(
                  file.licenseIssuedAt!,
                  file.licenseExpiresAt!,
                  new Date(),
                  contractYears,
                ),
              },
            },
            select: { id: true },
          });
          await tx.caseRequestEvent.create({
            data: {
              requestId: request.id,
              toStatus: CaseRequestStatus.OPEN,
              actorId: userId,
            },
          });
          return request.id;
        });
        return this.present(userId, file.id, requestId);
      } catch (error) {
        if (!isUniqueConflict(error)) throw error;
      }
    }
    throw new ConflictException('صدور شماره درخواست انجام نشد');
  }

  async continue(userId: string, caseId: string, requestId: string) {
    const request = await this.loadOpen(userId, caseId, requestId);
    if (request.intakeSubmittedAt) {
      throw new BadRequestException('درخواست برای بررسی مدیریت ثبت شده است');
    }
    const requirements = await resolveDocumentRequirements(
      this.prisma,
      request.caseFile.activityJobId,
      request.caseFile.user.gender,
    );
    const needsDocuments = requirements.some((row) => row.isRequired);
    let next = Math.min(request.formationStep + 1, 2);
    if (!needsDocuments && next === 1) next = 2;
    if (next >= 2) await this.assertDocuments(request.id, requirements);
    if (next >= 2 && !request.intakeSubmittedAt) {
      await this.prisma.caseRequest.update({
        where: { id: request.id },
        data: {
          formationStep: Math.max(request.formationStep, needsDocuments ? 1 : 0),
          intakeSubmittedAt: new Date(),
        },
      });
      return this.present(userId, caseId, requestId);
    }
    await this.prisma.caseRequest.update({
      where: { id: request.id },
      data: { formationStep: Math.max(request.formationStep, next) },
    });
    return this.present(userId, caseId, requestId);
  }

  async upload(
    userId: string,
    caseId: string,
    requestId: string,
    dto: UploadPortalRenewalDocumentDto,
    file: UploadFile | undefined,
  ) {
    const request = await this.loadOpen(userId, caseId, requestId);
    if (request.intakeSubmittedAt) {
      throw new BadRequestException('پس از ثبت اولیه، بارگذاری مدرک ممکن نیست');
    }
    if (!file?.buffer || file.size <= 0) {
      throw new BadRequestException('فایل را انتخاب کنید');
    }
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      throw new BadRequestException('نوع فایل مجاز نیست');
    }
    const requirements = await resolveDocumentRequirements(
      this.prisma,
      request.caseFile.activityJobId,
      request.caseFile.user.gender,
    );
    if (!requirements.some((row) => row.id === dto.documentId)) {
      throw new BadRequestException('نوع مدرک معتبر نیست');
    }
    const document = await this.prisma.caseActivityDocument.upsert({
      where: {
        caseRequestId_documentId: {
          caseRequestId: request.id,
          documentId: dto.documentId,
        },
      },
      create: {
        caseFileId: caseId,
        caseRequestId: request.id,
        documentId: dto.documentId,
      },
      update: {},
      select: { id: true },
    });
    const version =
      1 +
      (await this.prisma.caseActivityDocumentVersion.count({
        where: { caseActivityDocumentId: document.id },
      }));
    const extension =
      file.mimetype === 'application/pdf'
        ? '.pdf'
        : file.mimetype === 'image/png'
          ? '.png'
          : file.mimetype === 'image/webp'
            ? '.webp'
            : '.jpg';
    const storageKey = `persons/${userId}/cases/${caseId}/documents/${document.id}/v${version}${extension}`;
    const root = path.resolve(this.config.getOrThrow<string>('storage.root'));
    const absolute = path.resolve(root, storageKey);
    if (!absolute.startsWith(`${root}${path.sep}`)) {
      throw new BadRequestException('مسیر فایل معتبر نیست');
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.buffer, { flag: 'wx' });
    try {
      await this.prisma.caseActivityDocumentVersion.create({
        data: {
          caseActivityDocumentId: document.id,
          version,
          storageKey,
          originalName: file.originalname,
          mimeType: file.mimetype,
          byteSize: file.size,
        },
      });
    } catch (error) {
      await unlink(absolute).catch(() => undefined);
      throw error;
    }
    if (request.formationStep < 1) {
      await this.prisma.caseRequest.update({
        where: { id: request.id },
        data: { formationStep: 1 },
      });
    }
    return this.present(userId, caseId, requestId);
  }

  async inquiryFile(
    userId: string,
    caseId: string,
    requestId: string,
    inquiryId: string,
    fileId: string,
  ) {
    const file = await this.prisma.caseInquiryFile.findFirst({
      where: {
        id: fileId,
        caseInquiryId: inquiryId,
        caseInquiry: {
          caseFileId: caseId,
          caseRequestId: requestId,
          caseFile: { userId },
          caseRequest: { type: CaseRequestType.RENEWAL },
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

  async placesFile(userId: string, caseId: string, requestId: string, fileId: string) {
    const file = await this.prisma.casePlacesFile.findFirst({
      where: {
        id: fileId,
        review: {
          caseFileId: caseId,
          caseRequestId: requestId,
          caseFile: { userId },
          caseRequest: { type: CaseRequestType.RENEWAL },
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
    requestId: string,
    reviewId: string,
    fileId: string,
  ) {
    const file = await this.prisma.caseManagementReviewFile.findFirst({
      where: {
        id: fileId,
        reviewId,
        review: {
          id: reviewId,
          caseFileId: caseId,
          caseRequestId: requestId,
          caseFile: { userId },
          caseRequest: { type: CaseRequestType.RENEWAL },
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

  private async present(userId: string, caseId: string, requestId: string) {
    const request = await this.load(userId, caseId, requestId);
    const contractYears = await readContractYears(this.prisma);
    const terms =
      request.status === CaseRequestStatus.OPEN && request.renewalTerms
        ? await this.alignDefaultExpiry(request.renewalTerms, contractYears)
        : request.renewalTerms;
    const requirements = await resolveDocumentRequirements(
      this.prisma,
      request.caseFile.activityJobId,
      request.caseFile.user.gender,
    );
    const stored = await this.prisma.caseActivityDocument.findMany({
      where: { caseRequestId: request.id },
      select: {
        documentId: true,
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: {
            id: true,
            version: true,
            originalName: true,
            mimeType: true,
            byteSize: true,
          },
        },
      },
    });
    const titles = request.managementReviews.length
      ? await this.prisma.caseProcessManagementRole.findMany({
          where: {
            requestType: CaseRequestType.RENEWAL,
            roleId: { in: request.managementReviews.map((item) => item.role.id) },
          },
          select: { roleId: true, title: true },
        })
      : [];
    const uploaded = new Set(
      stored.filter((row) => row.versions[0]).map((row) => row.documentId),
    );
    const documentsMissing = requirements.some(
      (row) => row.isRequired && !uploaded.has(row.id),
    );
    const open = request.status === CaseRequestStatus.OPEN;
    const awaitingIntake = open && Boolean(request.intakeSubmittedAt) && request.formationStep < 2;
    return {
      id: request.id,
      caseId,
      number: request.number,
      type: request.type,
      status: request.status,
      formationStep: request.formationStep,
      completedAt: iso(request.completedAt),
      awaitingIntake,
      canUpload: open && !request.intakeSubmittedAt,
      canContinue: open && request.formationStep < 2 && !request.intakeSubmittedAt,
      documentsMissing,
      needsDocuments: requirements.some((row) => row.isRequired),
      contractYears,
      licenseNumber: request.caseFile.licenseNumber,
      businessUnitTitle: request.caseFile.businessUnitTitle,
      jobTitle: request.caseFile.activityJob?.title ?? null,
      person: {
        firstName: request.caseFile.user.firstName,
        lastName: request.caseFile.user.lastName,
        fullName: request.caseFile.user.fullName,
      },
      renewal: terms
        ? {
            currentIssuedAt: dateOnly(terms.currentIssuedAt),
            currentExpiresAt: dateOnly(terms.currentExpiresAt),
            nextIssuedAt: dateOnly(terms.nextIssuedAt),
            nextExpiresAt: dateOnly(terms.nextExpiresAt),
            delayDays: terms.delayDays,
          }
        : null,
      requirements,
      documents: stored.map((row) => ({
        documentId: row.documentId,
        current: row.versions[0] ?? null,
      })),
      inquiries: request.inquiries.map((row) => ({
        id: row.id,
        status: row.status,
        note: row.note,
        referredAt: iso(row.referredAt),
        decidedAt: iso(row.decidedAt),
        decidedBy: row.decidedBy,
        inquiryCenter: row.inquiryCenter,
        files: row.files,
      })),
      placesReview: request.placesReview
        ? {
            id: request.placesReview.id,
            status: request.placesReview.status,
            note: request.placesReview.note,
            referredAt: iso(request.placesReview.referredAt),
            decidedAt: iso(request.placesReview.decidedAt),
            decidedBy: request.placesReview.decidedBy,
            files: request.placesReview.files,
          }
        : null,
      managementReviews: request.managementReviews.map((row) => ({
        id: row.id,
        status: row.status,
        note: row.note,
        referredAt: iso(row.createdAt),
        decidedAt: iso(row.decidedAt),
        decidedBy: row.decidedBy,
        title:
          titles.find((item) => item.roleId === row.role.id)?.title ??
          [row.workUnit?.title, row.role.name].filter(Boolean).join(' · '),
        files: row.files,
      })),
    };
  }

  private async load(userId: string, caseId: string, requestId: string) {
    const request = await this.prisma.caseRequest.findFirst({
      where: {
        id: requestId,
        caseFileId: caseId,
        type: CaseRequestType.RENEWAL,
        caseFile: { userId },
      },
      select: {
        id: true,
        number: true,
        type: true,
        status: true,
        formationStep: true,
        intakeSubmittedAt: true,
        completedAt: true,
        renewalTerms: true,
        caseFile: {
          select: {
            userId: true,
            licenseNumber: true,
            businessUnitTitle: true,
            activityJobId: true,
            activityJob: { select: { title: true } },
            user: {
              select: {
                firstName: true,
                lastName: true,
                fullName: true,
                gender: true,
              },
            },
          },
        },
        inquiries: {
          orderBy: [{ inquiryCenter: { name: 'asc' } }, { id: 'asc' }],
          select: {
            id: true,
            status: true,
            note: true,
            referredAt: true,
            decidedAt: true,
            decidedBy: { select: { fullName: true } },
            inquiryCenter: { select: { name: true } },
            files: { orderBy: { createdAt: 'asc' }, select: reviewFileSelect },
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
            files: { orderBy: { createdAt: 'asc' }, select: reviewFileSelect },
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
            files: { orderBy: { createdAt: 'asc' }, select: reviewFileSelect },
          },
        },
      },
    });
    if (!request) throw new NotFoundException('درخواست تمدید یافت نشد');
    return request;
  }

  private async loadOpen(userId: string, caseId: string, requestId: string) {
    const request = await this.prisma.caseRequest.findFirst({
      where: {
        id: requestId,
        caseFileId: caseId,
        type: CaseRequestType.RENEWAL,
        caseFile: { userId },
      },
      select: {
        id: true,
        status: true,
        formationStep: true,
        intakeSubmittedAt: true,
        caseFile: {
          select: {
            activityJobId: true,
            user: { select: { gender: true } },
          },
        },
      },
    });
    if (!request) throw new NotFoundException('درخواست تمدید یافت نشد');
    if (request.status !== CaseRequestStatus.OPEN) {
      throw new BadRequestException('این درخواست قابل ویرایش نیست');
    }
    return request;
  }

  private async ownedCase(userId: string, caseId: string) {
    const file = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId, kind: CaseFileKind.LICENSE },
      select: {
        id: true,
        userId: true,
        status: true,
        licenseNumber: true,
        licenseIssuedAt: true,
        licenseExpiresAt: true,
        kind: true,
      },
    });
    if (!file) throw new NotFoundException('پرونده یافت نشد');
    return file;
  }

  private assertCanStart(file: {
    status: CaseFileStatus;
    licenseNumber: string | null;
    licenseIssuedAt: Date | null;
    licenseExpiresAt: Date | null;
  }) {
    if (file.status === CaseFileStatus.REVOKED) {
      throw new BadRequestException('روی پرونده ابطال‌شده درخواست جدید ثبت نمی‌شود');
    }
    if (!file.licenseNumber || !file.licenseIssuedAt || !file.licenseExpiresAt) {
      throw new BadRequestException(
        'قبل از تمدید باید مجوز فعالیت اقتصادی صادر شده باشد',
      );
    }
  }

  private async alignDefaultExpiry(
    terms: {
      requestId: string;
      nextIssuedAt: Date;
      nextExpiresAt: Date;
      currentIssuedAt: Date;
      currentExpiresAt: Date;
      delayDays: number;
    },
    years: number,
  ) {
    const issued = utcDateOnly(terms.nextIssuedAt);
    const expires = utcDateOnly(terms.nextExpiresAt);
    const target = clampContractYears(years);
    let span: number | null = null;
    for (let count = CONTRACT_DURATION_MIN; count <= CONTRACT_DURATION_MAX; count++) {
      if (addUtcYears(issued, count).getTime() === expires.getTime()) span = count;
    }
    if (span == null || span === target) return terms;
    const nextExpiresAt = addUtcYears(issued, target);
    await this.prisma.caseRenewalTerms.update({
      where: { requestId: terms.requestId },
      data: { nextExpiresAt },
    });
    return { ...terms, nextExpiresAt };
  }

  private async assertDocuments(
    requestId: string,
    requirements: Array<{ id: string; isRequired: boolean }>,
  ) {
    if (!requirements.some((row) => row.isRequired)) return;
    const stored = await this.prisma.caseActivityDocument.findMany({
      where: { caseRequestId: requestId, versions: { some: {} } },
      select: { documentId: true },
    });
    const uploaded = new Set(stored.map((row) => row.documentId));
    if (requirements.some((row) => row.isRequired && !uploaded.has(row.id))) {
      throw new BadRequestException('مدارک الزامی این درخواست کامل نیست');
    }
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
}
