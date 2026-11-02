import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  CaseFileKind,
  CaseFileStatus,
  CaseRequestStatus,
  CaseRequestType,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { readStoredBytes, removeStoredKeys } from '../storage/stored-file';

type Db = PrismaService | Prisma.TransactionClient;

type UploadFile = {
  buffer: Buffer;
  size: number;
  mimetype: string;
  originalname: string;
};

export class SubmitPortalRevocationDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'علت ابطال را وارد کنید' })
  @MinLength(1, { message: 'علت ابطال را وارد کنید' })
  @MaxLength(2000, { message: 'علت ابطال طولانی است' })
  reason: string;
}

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

function dateOnly(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function jalaliYear(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (month < 3 || (month === 3 && day < 21)) return year - 622;
  return year - 621;
}

function uploadExtension(mimeType: string) {
  if (mimeType === 'application/pdf') return '.pdf';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
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

@Injectable()
export class PortalRevocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async get(userId: string, caseId: string) {
    const file = await this.ownedLicense(userId, caseId);
    const request = await this.prisma.caseRequest.findFirst({
      where: { caseFileId: file.id, type: CaseRequestType.REVOCATION },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: {
        revocation: {
          include: { files: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
        },
      },
    });
    return {
      case: {
        id: file.id,
        fullName: file.user.fullName,
        licenseNumber: file.licenseNumber,
        licenseIssuedAt: dateOnly(file.licenseIssuedAt),
        jobTitle: file.activityJob?.title ?? null,
        businessUnitTitle: file.businessUnitTitle,
        status: file.status,
      },
      canSubmit:
        file.status !== CaseFileStatus.REVOKED &&
        Boolean(file.licenseNumber) &&
        !file.requests.some((item) => item.status === CaseRequestStatus.OPEN),
      request: request
        ? {
            id: request.id,
            number: request.number,
            status: request.status,
            reason: request.revocation?.reason ?? '',
            createdAt: request.createdAt.toISOString(),
            files: (request.revocation?.files ?? []).map((item) => ({
              id: item.id,
              originalName: item.originalName,
              mimeType: item.mimeType,
              byteSize: item.byteSize,
            })),
          }
        : null,
    };
  }

  async submit(userId: string, caseId: string, dto: SubmitPortalRevocationDto, uploads: UploadFile[] = []) {
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('علت ابطال را وارد کنید');
    const file = await this.ownedLicense(userId, caseId);
    this.assertCanSubmit(file);
    const prepared = uploads.filter((item) => item?.buffer?.length);
    for (const upload of prepared) {
      if (!ALLOWED_MIME.includes(upload.mimetype.split(';')[0].trim().toLowerCase())) {
        throw new BadRequestException('فقط تصویر یا PDF مجاز است');
      }
    }
    const storedKeys: string[] = [];
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const number = await nextRequestNumber(this.prisma);
        try {
          return await this.prisma.$transaction(async (tx) => {
            const open = await tx.caseRequest.findFirst({
              where: { caseFileId: file.id, status: CaseRequestStatus.OPEN },
              select: { id: true },
            });
            if (open) throw new BadRequestException('یک درخواست باز روی این پرونده وجود دارد');
            const request = await tx.caseRequest.create({
              data: {
                caseFileId: file.id,
                type: CaseRequestType.REVOCATION,
                number,
                status: CaseRequestStatus.OPEN,
                formationStep: 0,
                intakeSubmittedAt: new Date(),
              },
              select: { id: true, number: true },
            });
            await tx.caseRequestEvent.create({
              data: { requestId: request.id, toStatus: CaseRequestStatus.OPEN, actorId: userId },
            });
            await tx.caseRevocationRequest.create({
              data: { requestId: request.id, reason },
            });
            const root = path.resolve(this.config.getOrThrow<string>('storage.root'));
            for (const upload of prepared) {
              const fileId = randomUUID();
              const ext = uploadExtension(upload.mimetype);
              const storageKey = [
                'persons',
                file.userId,
                'cases',
                file.id,
                'revocation-request',
                `${fileId}${ext}`,
              ].join('/');
              const absolute = path.resolve(root, storageKey);
              if (!absolute.startsWith(`${root}${path.sep}`)) {
                throw new BadRequestException('مسیر فایل معتبر نیست');
              }
              await mkdir(path.dirname(absolute), { recursive: true });
              await writeFile(absolute, upload.buffer);
              storedKeys.push(storageKey);
              await tx.caseRevocationRequestFile.create({
                data: {
                  id: fileId,
                  requestId: request.id,
                  storageKey,
                  originalName: upload.originalname,
                  mimeType: upload.mimetype,
                  byteSize: upload.size,
                },
              });
            }
            const roles = await tx.caseProcessManagementRole.findMany({
              where: { requestType: CaseRequestType.REVOCATION },
              select: { roleId: true },
            });
            if (roles.length) {
              await tx.caseManagementReview.createMany({
                data: roles.map((item) => ({
                  caseFileId: file.id,
                  caseRequestId: request.id,
                  roleId: item.roleId,
                })),
                skipDuplicates: true,
              });
            }
            return { id: request.id, number: request.number };
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            continue;
          }
          throw error;
        }
      }
      throw new ConflictException('صدور شماره درخواست انجام نشد');
    } catch (error) {
      if (storedKeys.length) {
        await removeStoredKeys(storedKeys, this.config.getOrThrow<string>('storage.root'));
      }
      throw error;
    }
  }

  async file(userId: string, caseId: string, fileId: string) {
    await this.ownedLicense(userId, caseId);
    const row = await this.prisma.caseRevocationRequestFile.findFirst({
      where: {
        id: fileId,
        request: { request: { caseFileId: caseId, userId } },
      },
    });
    if (!row) throw new NotFoundException('پیوست یافت نشد');
    return {
      mimeType: row.mimeType,
      originalName: row.originalName,
      data: await readStoredBytes(row.storageKey, this.config.getOrThrow<string>('storage.root')),
    };
  }

  private assertCanSubmit(file: {
    status: CaseFileStatus;
    licenseNumber: string | null;
    requests: { status: CaseRequestStatus }[];
  }) {
    if (file.status === CaseFileStatus.REVOKED) {
      throw new BadRequestException('روی پرونده ابطال‌شده درخواست جدید ثبت نمی‌شود');
    }
    if (!file.licenseNumber) {
      throw new BadRequestException('مجوز فعالیت اقتصادی هنوز صادر نشده است');
    }
    if (file.requests.some((item) => item.status === CaseRequestStatus.OPEN)) {
      throw new BadRequestException('یک درخواست باز روی این پرونده وجود دارد');
    }
  }

  private async ownedLicense(userId: string, caseId: string) {
    const file = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId, kind: CaseFileKind.LICENSE },
      select: {
        id: true,
        userId: true,
        status: true,
        licenseNumber: true,
        licenseIssuedAt: true,
        businessUnitTitle: true,
        activityJob: { select: { title: true } },
        user: { select: { fullName: true } },
        requests: { select: { status: true, type: true } },
      },
    });
    if (!file) throw new NotFoundException('پرونده یافت نشد');
    return file;
  }
}
