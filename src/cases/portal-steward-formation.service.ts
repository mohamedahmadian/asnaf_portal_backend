import {
  BadRequestException,
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
import { SavePortalStewardIdentityDto } from './dto/save-portal-steward-identity.dto';

type Db = PrismaService | Prisma.TransactionClient;

type UploadFile = {
  buffer: Buffer;
  size: number;
  mimetype: string;
  originalname: string;
};

export class UploadPortalStewardDocumentDto {
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,64}$/)
  documentId: string;
}

const PERSONNEL_PHOTO_CODE = 'PERSONNEL_PHOTO';
const STEWARDSHIP_INQUIRY_STEP = 1;
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

function dateOnly(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function parseDate(value: string | null | undefined) {
  if (!value) return null;
  return new Date(`${value}T00:00:00.000Z`);
}

function matchesDocumentGender(
  gender: DocumentGender,
  personGender: 'MALE' | 'FEMALE' | null,
) {
  return gender === DocumentGender.BOTH || !personGender || gender === personGender;
}

async function activityJobId(prisma: Db, caseFileId: string) {
  const row = await prisma.caseFile.findUnique({
    where: { id: caseFileId },
    select: {
      kind: true,
      activityJobId: true,
      hostCaseFile: { select: { activityJobId: true } },
    },
  });
  if (!row) return null;
  if (row.kind === CaseFileKind.STEWARDSHIP && row.hostCaseFile) {
    return row.hostCaseFile.activityJobId;
  }
  return row.activityJobId;
}

async function resolveInquiryCenterIds(
  prisma: Db,
  jobId: string | null,
) {
  const rows = await prisma.inquiryRequirement.findMany({
    where: {
      requestType: CaseRequestType.STEWARDSHIP,
      inquiryCenter: { isActive: true },
      OR: [{ jobId: null }, ...(jobId ? [{ jobId }] : [])],
    },
    select: { inquiryCenterId: true },
  });
  return [...new Set(rows.map((row) => row.inquiryCenterId))];
}

@Injectable()
export class PortalStewardFormationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  find(userId: string, caseId: string) {
    return this.present(userId, caseId);
  }

  async saveIdentity(
    userId: string,
    caseId: string,
    dto: SavePortalStewardIdentityDto,
  ) {
    await this.assertEditable(userId, caseId);
    if (dto.countryId) {
      const country = await this.prisma.country.findFirst({
        where: { id: dto.countryId, isActive: true },
        select: { id: true },
      });
      if (!country) throw new BadRequestException('ملیت معتبر نیست');
    }
    if (dto.jobId) {
      const job = await this.prisma.job.findFirst({
        where: { id: dto.jobId, isActive: true },
        select: { id: true },
      });
      if (!job) throw new BadRequestException('شغل معتبر نیست');
    }
    const phone = dto.phone?.trim() || null;
    if (phone) {
      const duplicate = await this.prisma.user.findFirst({
        where: { phone, id: { not: userId } },
        select: { id: true },
      });
      if (duplicate) {
        throw new BadRequestException('این تلفن همراه قبلاً ثبت شده است');
      }
    }
    const email = dto.email?.trim().toLowerCase() || null;
    if (email) {
      const duplicate = await this.prisma.user.findFirst({
        where: { email, id: { not: userId } },
        select: { id: true },
      });
      if (duplicate) {
        throw new BadRequestException('این ایمیل قبلاً ثبت شده است');
      }
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        fullName: `${dto.firstName.trim()} ${dto.lastName.trim()}`,
        fatherName: dto.fatherName?.trim() || null,
        lastNameEn: dto.lastNameEn?.trim() || null,
        gender: dto.gender ?? null,
        religion: dto.religion ?? null,
        religionOther:
          dto.religion === 'OTHER' ? dto.religionOther?.trim() || null : null,
        birthDate: parseDate(dto.birthDate),
        residencyStatus: dto.residencyStatus ?? null,
        passportNumber: dto.passportNumber?.trim() || null,
        nationalCardExpiresAt: parseDate(dto.nationalCardExpiresAt),
        passportExpiresAt: parseDate(dto.passportExpiresAt),
        identityCertificateNo: dto.identityCertificateNo?.trim() || null,
        birthPlace: dto.birthPlace?.trim() || null,
        identityIssuedIn: dto.identityIssuedIn?.trim() || null,
        countryId: dto.countryId ?? null,
        phone,
        homePhone: dto.homePhone?.replace(/\D/g, '') || null,
        postalCode: dto.postalCode?.replace(/\D/g, '') || null,
        address: dto.address?.trim() || null,
        email,
        educationLevel: dto.educationLevel ?? null,
        citizenGroup: dto.citizenGroup?.trim() || null,
        jobId: dto.jobId ?? null,
      },
    });
    return this.present(userId, caseId);
  }

  async upload(
    userId: string,
    caseId: string,
    dto: UploadPortalStewardDocumentDto,
    file: UploadFile | undefined,
  ) {
    await this.assertEditable(userId, caseId);
    if (!file?.buffer || file.size <= 0) {
      throw new BadRequestException('فایل را انتخاب کنید');
    }
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      throw new BadRequestException('نوع فایل مجاز نیست');
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { gender: true },
    });
    const requirements = await this.identityRequirements(user.gender);
    if (!requirements.some((row) => row.id === dto.documentId)) {
      throw new BadRequestException('نوع مدرک معتبر نیست');
    }
    const document = await this.prisma.personDocument.upsert({
      where: {
        userId_documentId: { userId, documentId: dto.documentId },
      },
      create: { userId, documentId: dto.documentId },
      update: {},
      select: { id: true },
    });
    const version =
      1 +
      (await this.prisma.personDocumentVersion.count({
        where: { personDocumentId: document.id },
      }));
    const extension =
      file.mimetype === 'application/pdf'
        ? '.pdf'
        : file.mimetype === 'image/png'
          ? '.png'
          : file.mimetype === 'image/webp'
            ? '.webp'
            : '.jpg';
    const storageKey = `persons/${userId}/documents/${document.id}/v${version}${extension}`;
    const root = path.resolve(this.config.getOrThrow<string>('storage.root'));
    const absolute = path.resolve(root, storageKey);
    if (!absolute.startsWith(`${root}${path.sep}`)) {
      throw new BadRequestException('مسیر فایل معتبر نیست');
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.buffer, { flag: 'wx' });
    try {
      await this.prisma.personDocumentVersion.create({
        data: {
          personDocumentId: document.id,
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
    return this.present(userId, caseId);
  }

  async removeDocument(userId: string, caseId: string, documentId: string) {
    await this.assertEditable(userId, caseId);
    const row = await this.prisma.personDocument.findFirst({
      where: { userId, documentId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('مدرک یافت نشد');
    await this.prisma.personDocument.delete({ where: { id: row.id } });
    return this.present(userId, caseId);
  }

  async continue(userId: string, caseId: string) {
    const { file, request } = await this.loadOpen(userId, caseId);
    if (request.formationStep >= STEWARDSHIP_INQUIRY_STEP) {
      return this.present(userId, caseId);
    }
    await this.assertIdentity(userId);
    const next = STEWARDSHIP_INQUIRY_STEP;
    await this.prisma.$transaction([
      this.prisma.caseRequest.update({
        where: { id: request.id },
        data: { formationStep: next },
      }),
      this.prisma.caseFile.update({
        where: { id: file.id },
        data: { formationStep: next },
      }),
    ]);
    await this.ensureInquiries(caseId, request.id);
    await this.referOpenRequest(caseId, request.id);
    return this.present(userId, caseId);
  }

  async inquiryFile(
    userId: string,
    caseId: string,
    inquiryId: string,
    fileId: string,
  ) {
    const request = await this.openRequestId(userId, caseId);
    const file = await this.prisma.caseInquiryFile.findFirst({
      where: {
        id: fileId,
        caseInquiryId: inquiryId,
        caseInquiry: {
          caseFileId: caseId,
          caseRequestId: request,
          caseFile: { userId },
          caseRequest: { type: CaseRequestType.STEWARDSHIP },
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
    const requestId = await this.openRequestId(userId, caseId);
    const file = await this.prisma.casePlacesFile.findFirst({
      where: {
        id: fileId,
        review: {
          caseFileId: caseId,
          caseRequestId: requestId,
          caseFile: { userId },
          caseRequest: { type: CaseRequestType.STEWARDSHIP },
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
    const requestId = await this.openRequestId(userId, caseId);
    const file = await this.prisma.caseManagementReviewFile.findFirst({
      where: {
        id: fileId,
        reviewId,
        review: {
          caseFileId: caseId,
          caseRequestId: requestId,
          caseFile: { userId },
          caseRequest: { type: CaseRequestType.STEWARDSHIP },
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

  private async present(userId: string, caseId: string) {
    const { file, request } = await this.loadOpen(userId, caseId);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
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
      },
    });
    const requirements = await this.identityRequirements(user.gender);
    const stored = await this.prisma.personDocument.findMany({
      where: { userId },
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
    const uploaded = new Set(
      stored.filter((row) => row.versions[0]).map((row) => row.documentId),
    );
    const documentsMissing = requirements.some(
      (row) => row.isRequired && !uploaded.has(row.id),
    );
    const open = request.status === CaseRequestStatus.OPEN;
    const editable =
      open &&
      file.status !== CaseFileStatus.REVOKED &&
      request.formationStep < STEWARDSHIP_INQUIRY_STEP;
    if (open && request.formationStep >= STEWARDSHIP_INQUIRY_STEP) {
      await this.ensureInquiries(caseId, request.id);
      await this.referOpenRequest(caseId, request.id);
    }
    const titles = request.managementReviews.length
      ? await this.prisma.caseProcessManagementRole.findMany({
          where: {
            requestType: CaseRequestType.STEWARDSHIP,
            roleId: {
              in: request.managementReviews.map((item) => item.role.id),
            },
          },
          select: { roleId: true, title: true },
        })
      : [];
    return {
      caseId: file.id,
      requestId: request.id,
      number: request.number,
      status: request.status,
      formationStep: request.formationStep,
      cardNumber: file.cardNumber,
      editable,
      canContinue: editable && !documentsMissing,
      documentsMissing,
      host: file.hostCaseFile
        ? {
            licenseNumber: file.hostCaseFile.licenseNumber,
            businessUnitTitle: file.hostCaseFile.businessUnitTitle,
            jobTitle: file.hostCaseFile.activityJob?.title ?? null,
            fullName: file.hostCaseFile.user.fullName,
          }
        : null,
      person: {
        id: user.id,
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
        jobId: user.economicJob?.id ?? null,
        jobTitle: user.economicJob?.title ?? null,
      },
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

  private async identityRequirements(personGender: 'MALE' | 'FEMALE' | null) {
    const rows = await this.prisma.caseIdentityDocument.findMany({
      where: { document: { NOT: { code: PERSONNEL_PHOTO_CODE } } },
      select: {
        gender: true,
        isRequired: true,
        document: { select: { id: true, code: true, title: true } },
      },
      orderBy: { document: { title: 'asc' } },
    });
    const byId = new Map<
      string,
      { id: string; code: string | null; title: string; isRequired: boolean }
    >();
    for (const row of rows) {
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
    return [...byId.values()];
  }

  private async assertIdentity(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { firstName: true, lastName: true, gender: true },
    });
    if (!user.firstName.trim() || !user.lastName.trim()) {
      throw new BadRequestException('نام و نام خانوادگی مباشر را کامل کنید');
    }
    const requirements = await this.identityRequirements(user.gender);
    const needed = requirements.filter((row) => row.isRequired);
    if (!needed.length) return;
    const stored = await this.prisma.personDocument.findMany({
      where: { userId, documentId: { in: needed.map((row) => row.id) } },
      select: { documentId: true, versions: { select: { id: true }, take: 1 } },
    });
    const uploaded = new Set(
      stored.filter((row) => row.versions.length > 0).map((row) => row.documentId),
    );
    if (needed.some((row) => !uploaded.has(row.id))) {
      throw new BadRequestException('مدارک هویتی الزامی مباشر کامل نیست');
    }
  }

  private async ensureInquiries(caseFileId: string, caseRequestId: string) {
    const jobId = await activityJobId(this.prisma, caseFileId);
    const centerIds = await resolveInquiryCenterIds(this.prisma, jobId);
    if (!centerIds.length) return;
    await this.prisma.caseInquiry.createMany({
      data: centerIds.map((inquiryCenterId) => ({
        caseFileId,
        caseRequestId,
        inquiryCenterId,
      })),
      skipDuplicates: true,
    });
  }

  private async referOpenRequest(caseFileId: string, caseRequestId: string) {
    await this.prisma.caseInquiry.updateMany({
      where: { caseRequestId, referredAt: null },
      data: { referredAt: new Date() },
    });
  }

  private async loadOpen(userId: string, caseId: string) {
    const file = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId, kind: CaseFileKind.STEWARDSHIP },
      select: {
        id: true,
        status: true,
        cardNumber: true,
        formationStep: true,
        hostCaseFile: {
          select: {
            licenseNumber: true,
            businessUnitTitle: true,
            user: { select: { fullName: true } },
            activityJob: { select: { title: true } },
          },
        },
        requests: {
          where: { type: CaseRequestType.STEWARDSHIP },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: {
            id: true,
            number: true,
            status: true,
            formationStep: true,
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
                files: {
                  orderBy: { createdAt: 'asc' },
                  select: reviewFileSelect,
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
                  select: reviewFileSelect,
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
                  select: reviewFileSelect,
                },
              },
            },
          },
        },
      },
    });
    if (!file) throw new NotFoundException('پرونده مباشرت یافت نشد');
    const request = file.requests[0];
    if (!request) throw new BadRequestException('درخواست مباشرت یافت نشد');
    if (file.status === CaseFileStatus.REVOKED) {
      throw new BadRequestException('این کارت ابطال شده است');
    }
    if (request.status !== CaseRequestStatus.OPEN) {
      throw new BadRequestException('درخواست باز مباشرت یافت نشد');
    }
    return { file, request };
  }

  private async assertEditable(userId: string, caseId: string) {
    const { file, request } = await this.loadOpen(userId, caseId);
    if (request.status !== CaseRequestStatus.OPEN) {
      throw new BadRequestException('این درخواست قابل ویرایش نیست');
    }
    if (request.formationStep >= STEWARDSHIP_INQUIRY_STEP) {
      throw new BadRequestException('پس از ارجاع به استعلام، ویرایش ممکن نیست');
    }
    if (file.status === CaseFileStatus.REVOKED) {
      throw new BadRequestException('این کارت ابطال شده است');
    }
  }

  private async openRequestId(userId: string, caseId: string) {
    const { request } = await this.loadOpen(userId, caseId);
    return request.id;
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
