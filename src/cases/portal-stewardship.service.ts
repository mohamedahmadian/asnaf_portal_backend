import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import {
  CaseFileKind,
  CaseFileStatus,
  CaseRequestStatus,
  CaseRequestType,
  Prisma,
  UserStatus,
} from '../generated/prisma/client';
import { normalizeNationalId } from '../auth/identity';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';

const ECONOMIC_ACTOR_ROLE = 'ECONOMIC_ACTOR';

type Db = PrismaService | Prisma.TransactionClient;

function jalaliYear(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (month < 3 || (month === 3 && day < 21)) return year - 622;
  return year - 621;
}

function localTodayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function parseDate(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T00:00:00.000Z`);
}

function dateOnly(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function suspensionCoversToday(row: {
  startsAt: Date;
  endsAt: Date | null;
  liftedAt: Date | null;
}) {
  if (row.liftedAt) return false;
  const today = parseDate(localTodayIso());
  if (!today) return false;
  if (row.startsAt.getTime() > today.getTime()) return false;
  if (!row.endsAt) return true;
  return row.endsAt.getTime() >= today.getTime();
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

const stewardListSelect = {
  id: true,
  status: true,
  cardNumber: true,
  cardIssuedAt: true,
  cardExpiresAt: true,
  user: { select: { firstName: true, lastName: true, fullName: true, nationalId: true, phone: true } },
  requests: {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 1,
    select: { number: true, status: true, createdAt: true },
  },
} satisfies Prisma.CaseFileSelect;

function mapStewardRow(row: Prisma.CaseFileGetPayload<{ select: typeof stewardListSelect }>) {
  const request = row.requests[0] ?? null;
  return {
    id: row.id,
    status: row.status,
    firstName: row.user.firstName,
    lastName: row.user.lastName,
    fullName: row.user.fullName,
    nationalId: row.user.nationalId,
    phone: row.user.phone,
    requestNumber: request?.number ?? null,
    requestStatus: request?.status ?? null,
    requestCreatedAt: dateOnly(request?.createdAt ?? null),
    cardNumber: row.cardNumber,
    cardIssuedAt: dateOnly(row.cardIssuedAt),
    cardExpiresAt: dateOnly(row.cardExpiresAt),
  };
}

export function portalStewardshipActionEnabled(row: {
  kind: CaseFileKind;
  status: CaseFileStatus;
  licenseNumber: string | null;
  suspensions: { startsAt: Date; endsAt: Date | null; liftedAt: Date | null }[];
}) {
  if (row.kind !== CaseFileKind.LICENSE) return false;
  if (!row.licenseNumber) return false;
  if (row.status === CaseFileStatus.REVOKED) return false;
  if (row.status === CaseFileStatus.EXPIRED) return false;
  if (row.status === CaseFileStatus.SUSPENDED) return false;
  if (row.suspensions.some((item) => suspensionCoversToday(item))) return false;
  return true;
}

@Injectable()
export class PortalStewardshipService {
  private readonly logger = new Logger(PortalStewardshipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
  ) {}

  async list(userId: string, hostCaseId: string) {
    await this.ownedLicense(userId, hostCaseId);
    const rows = await this.prisma.caseFile.findMany({
      where: { hostCaseFileId: hostCaseId, kind: CaseFileKind.STEWARDSHIP },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: stewardListSelect,
    });
    return rows.map(mapStewardRow);
  }

  async lookup(userId: string, hostCaseId: string, nationalIdInput: string) {
    const host = await this.ownedLicense(userId, hostCaseId);
    this.assertCanAddSteward(host);
    const nationalId = this.requireNationalId(nationalIdInput);
    this.assertNotHostOwner(host, nationalId);

    const person = await this.prisma.user.findUnique({
      where: { nationalId },
      select: { id: true, firstName: true, lastName: true, nationalId: true, phone: true },
    });
    if (!person) {
      return { found: false as const, person: null };
    }
    this.assertNotHostOwner(host, nationalId, person.id);
    await this.assertNoOpenSteward(host.id, person.id);
    return {
      found: true as const,
      person: {
        firstName: person.firstName,
        lastName: person.lastName,
        nationalId: person.nationalId ?? nationalId,
        phone: person.phone,
      },
    };
  }

  async create(userId: string, hostCaseId: string, nationalIdInput: string, phoneInput?: string) {
    const host = await this.ownedLicense(userId, hostCaseId);
    this.assertCanAddSteward(host);
    const nationalId = this.requireNationalId(nationalIdInput);
    this.assertNotHostOwner(host, nationalId);

    const stewardUser = await this.resolveSteward(nationalId, phoneInput);
    this.assertNotHostOwner(host, nationalId, stewardUser.id);
    await this.assertNoOpenSteward(host.id, stewardUser.id);
    for (let attempt = 0; attempt < 4; attempt++) {
      const number = await nextRequestNumber(this.prisma);
      try {
        const created = await this.prisma.$transaction(async (tx) => {
          const again = await tx.caseFile.findFirst({
            where: {
              kind: CaseFileKind.STEWARDSHIP,
              hostCaseFileId: host.id,
              userId: stewardUser.id,
              requests: {
                some: { type: CaseRequestType.STEWARDSHIP, status: CaseRequestStatus.OPEN },
              },
            },
            select: { id: true },
          });
          if (again) {
            throw new BadRequestException('برای این شخص روی همین مجوز یک درخواست مباشرت باز وجود دارد');
          }
          const file = await tx.caseFile.create({
            data: {
              userId: stewardUser.id,
              kind: CaseFileKind.STEWARDSHIP,
              hostCaseFileId: host.id,
              formationStep: 0,
            },
            select: { id: true },
          });
          const request = await tx.caseRequest.create({
            data: {
              caseFileId: file.id,
              type: CaseRequestType.STEWARDSHIP,
              number,
              status: CaseRequestStatus.OPEN,
              formationStep: 0,
            },
            select: { id: true },
          });
          await tx.caseRequestEvent.create({
            data: { requestId: request.id, toStatus: CaseRequestStatus.OPEN },
          });
          return { id: file.id };
        });
        await this.notifySteward(stewardUser);
        return created;
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
      }
    }
    throw new ConflictException('صدور شماره درخواست انجام نشد');
  }

  async cancelOpen(userId: string, hostCaseId: string, stewardCaseId: string) {
    await this.ownedLicense(userId, hostCaseId);
    const steward = await this.prisma.caseFile.findFirst({
      where: {
        id: stewardCaseId,
        hostCaseFileId: hostCaseId,
        kind: CaseFileKind.STEWARDSHIP,
      },
      select: {
        id: true,
        cardNumber: true,
        requests: {
          where: { type: CaseRequestType.STEWARDSHIP },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { id: true, status: true },
        },
      },
    });
    if (!steward) throw new NotFoundException('پرونده مباشرت یافت نشد');
    if (steward.cardNumber) {
      throw new BadRequestException('پس از صدور کارت مباشرت، حذف درخواست از این مسیر ممکن نیست');
    }
    const request = steward.requests[0];
    if (!request || request.status !== CaseRequestStatus.OPEN) {
      throw new BadRequestException('فقط درخواست مباشرت در حال بررسی قابل حذف است');
    }
    const payments = await this.prisma.payment.count({
      where: {
        OR: [{ caseFileId: steward.id }, { caseRequestId: request.id }],
      },
    });
    if (payments > 0) {
      throw new BadRequestException('برای این درخواست پرداخت ثبت شده و حذف ممکن نیست');
    }
    await this.prisma.caseFile.delete({ where: { id: steward.id } });
    return { ok: true };
  }

  private assertCanAddSteward(host: {
    kind: CaseFileKind;
    status: CaseFileStatus;
    licenseNumber: string | null;
    suspensions: { startsAt: Date; endsAt: Date | null; liftedAt: Date | null }[];
  }) {
    if (host.kind !== CaseFileKind.LICENSE) throw new NotFoundException('پرونده یافت نشد');
    if (!host.licenseNumber) {
      throw new BadRequestException('قبل از افزودن مباشر باید مجوز صادر شده باشد');
    }
    if (host.status === CaseFileStatus.REVOKED) {
      throw new BadRequestException('روی پرونده ابطال‌شده مباشر اضافه نمی‌شود');
    }
    if (host.status === CaseFileStatus.EXPIRED) {
      throw new BadRequestException('روی پرونده منقضی‌شده مباشر اضافه نمی‌شود');
    }
    if (host.status === CaseFileStatus.SUSPENDED || host.suspensions.some((row) => suspensionCoversToday(row))) {
      throw new BadRequestException('روی پرونده معلق مباشر اضافه نمی‌شود');
    }
  }

  private async ownedLicense(userId: string, caseId: string) {
    const row = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId, kind: CaseFileKind.LICENSE },
      select: {
        id: true,
        kind: true,
        status: true,
        userId: true,
        licenseNumber: true,
        user: { select: { nationalId: true } },
        suspensions: {
          where: { liftedAt: null },
          select: { startsAt: true, endsAt: true, liftedAt: true },
        },
      },
    });
    if (!row) throw new NotFoundException('پرونده یافت نشد');
    return row;
  }

  private requireNationalId(nationalIdInput: string) {
    const nationalId = normalizeNationalId(nationalIdInput);
    if (!/^\d{10}$/.test(nationalId)) {
      throw new BadRequestException('کد ملی معتبر نیست');
    }
    return nationalId;
  }

  private assertNotHostOwner(
    host: { userId: string; user: { nationalId: string | null } },
    nationalId: string,
    stewardUserId?: string,
  ) {
    if (host.user.nationalId === nationalId || stewardUserId === host.userId) {
      throw new BadRequestException('صاحب مجوز نمی‌تواند مباشر همان پروانه باشد');
    }
  }

  private async assertNoOpenSteward(hostId: string, stewardUserId: string) {
    const open = await this.prisma.caseFile.findFirst({
      where: {
        kind: CaseFileKind.STEWARDSHIP,
        hostCaseFileId: hostId,
        userId: stewardUserId,
        requests: {
          some: { type: CaseRequestType.STEWARDSHIP, status: CaseRequestStatus.OPEN },
        },
      },
      select: { id: true },
    });
    if (open) {
      throw new BadRequestException('برای این شخص روی همین مجوز یک درخواست مباشرت باز وجود دارد');
    }
  }

  private requirePhone(phoneInput?: string) {
    const phone = (phoneInput ?? '').trim();
    if (!/^09\d{9}$/.test(phone)) {
      throw new BadRequestException('شماره همراه معتبر نیست');
    }
    return phone;
  }

  private async assertPhoneAvailable(phone: string, exceptUserId?: string) {
    const taken = await this.prisma.user.findFirst({
      where: {
        OR: [{ phone }, { username: phone }],
        ...(exceptUserId ? { NOT: { id: exceptUserId } } : {}),
      },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException('این تلفن همراه قبلاً ثبت شده است');
    }
  }

  private async resolveSteward(nationalId: string, phoneInput?: string) {
    const existing = await this.prisma.user.findUnique({
      where: { nationalId },
      select: { id: true, phone: true, nationalId: true },
    });
    if (existing) {
      if (existing.phone?.trim()) {
        return { ...existing, created: false as const };
      }
      const phone = this.requirePhone(phoneInput);
      await this.assertPhoneAvailable(phone, existing.id);
      const updated = await this.prisma.user.update({
        where: { id: existing.id },
        data: { phone },
        select: { id: true, phone: true, nationalId: true },
      });
      return { ...updated, created: false as const };
    }
    const phone = this.requirePhone(phoneInput);
    await this.assertPhoneAvailable(phone);
    const role = await this.prisma.role.upsert({
      where: { code: ECONOMIC_ACTOR_ROLE },
      update: { isSystem: true },
      create: {
        code: ECONOMIC_ACTOR_ROLE,
        name: 'فعال اقتصادی',
        description: 'نقش پیش‌فرض شخص هنگام تشکیل پرونده؛ قابل حذف نیست',
        isSystem: true,
      },
      select: { id: true },
    });
    const passwordHash = await bcrypt.hash(nationalId, 12);
    const user = await this.prisma.user.create({
      data: {
        username: phone,
        passwordHash,
        nationalId,
        phone,
        firstName: '',
        lastName: '',
        fullName: '',
        locale: 'fa',
        status: UserStatus.ACTIVE,
        userRoles: { create: { roleId: role.id } },
      },
      select: { id: true, phone: true, nationalId: true },
    });
    return { ...user, created: true as const };
  }

  private async notifySteward(user: {
    created: boolean;
    phone: string | null;
    nationalId: string | null;
  }) {
    if (!user.phone) return;
    const body = user.created
      ? [
          'پرونده مباشرت برای شما ایجاد شد.',
          'برای ورود به سامانه و تکمیل درخواست کارت مباشرت:',
          `نام کاربری: ${user.phone}`,
          `رمز عبور: ${user.nationalId ?? ''}`,
        ].join('\n')
      : 'پرونده مباشرت برای شما ایجاد شد. برای تکمیل درخواست کارت مباشرت وارد سامانه شوید.';
    try {
      await this.sms.send({ phone: user.phone, body, source: 'STEWARDSHIP' });
    } catch (error) {
      this.logger.warn(`Steward SMS failed for ${user.phone}: ${String(error)}`);
    }
  }
}
