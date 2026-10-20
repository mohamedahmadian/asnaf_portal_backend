import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuctionApproverKind,
  CaseFileKind,
  CaseFileStatus,
  CaseInquiryStatus,
  CaseRequestStatus,
  CaseRequestType,
  Prisma,
  UserStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { readStoredBytes } from '../storage/stored-file';
import { SavePortalAuctionDto } from './dto/save-portal-auction.dto';

type Db = PrismaService | Prisma.TransactionClient;

const APPROVER_KINDS = [
  AuctionApproverKind.SPECIAL_INSPECTOR,
  AuctionApproverKind.AUCTION_COMMITTEE,
  AuctionApproverKind.COMMERCIAL_MANAGER,
] as const;

const OCCUPIED_STATUSES = [
  CaseRequestStatus.OPEN,
  CaseRequestStatus.ISSUED,
  CaseRequestStatus.COMPLETED,
];

const auctionInclude = {
  items: { orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] },
  approvals: {
    include: { decidedBy: { select: { id: true, fullName: true } } },
  },
} satisfies Prisma.CaseAuctionInclude;

function parseDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function asNumber(value: Prisma.Decimal | number) {
  return typeof value === 'number' ? value : Number(value);
}

function hundredths(value: number) {
  return Math.round(value * 100);
}

function priceAfterDiscount(price: number, percent: number) {
  return Math.round((price * (10000 - hundredths(percent))) / 10000);
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function itemNameKey(name: string) {
  return name
    .trim()
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function jalaliYear(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (month < 3 || (month === 3 && day < 21)) return year - 622;
  return year - 621;
}

function assertRange(dto: SavePortalAuctionDto) {
  if (dto.endsAt < dto.startsAt) {
    throw new BadRequestException('تاریخ پایان باید بعد از تاریخ شروع یا همان روز باشد');
  }
  if (hundredths(dto.discountMax) < hundredths(dto.discountMin)) {
    throw new BadRequestException('حداکثر درصد تخفیف باید بزرگ‌تر یا مساوی حداقل درصد تخفیف باشد');
  }
  const min = hundredths(dto.discountMin);
  const max = hundredths(dto.discountMax);
  if (dto.items.some((item) => hundredths(item.discountPercent) < min || hundredths(item.discountPercent) > max)) {
    throw new BadRequestException('درصد تخفیف هر کالا باید بین حداقل و حداکثر درصد تخفیف باشد');
  }
  const names = new Set<string>();
  for (const item of dto.items) {
    const key = itemNameKey(item.name);
    if (names.has(key)) throw new BadRequestException('نام کالا در این مجوز نباید تکراری باشد');
    names.add(key);
  }
}

async function nextRequestNumber(prisma: Db) {
  const prefix = `REQ-${jalaliYear()}-`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const count = await prisma.caseRequest.count({
      where: { number: { startsWith: prefix } },
    });
    const number = `${prefix}${String(count + 1 + attempt).padStart(6, '0')}`;
    const taken = await prisma.caseRequest.findUnique({ where: { number }, select: { id: true } });
    if (!taken) return number;
  }
  throw new ConflictException('صدور شماره درخواست انجام نشد');
}

@Injectable()
export class PortalAuctionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async find(userId: string, caseId: string, requestId: string) {
    await this.ownedCase(userId, caseId);
    await this.refreshOpenPhase(this.prisma, requestId);
    return this.present(this.prisma, userId, caseId, requestId);
  }

  async create(userId: string, caseId: string, dto: SavePortalAuctionDto) {
    const file = await this.ownedCase(userId, caseId);
    this.assertCanStart(file);
    assertRange(dto);
    for (let attempt = 0; attempt < 4; attempt++) {
      const number = await nextRequestNumber(this.prisma);
      try {
        return await this.prisma.$transaction(async (tx) => {
          const open = await tx.caseRequest.findFirst({
            where: { caseFileId: file.id, status: CaseRequestStatus.OPEN },
            select: { id: true },
          });
          if (open) throw new BadRequestException('یک درخواست باز روی این پرونده وجود دارد');
          await this.assertNoOverlap(tx, file.userId, dto.startsAt, dto.endsAt);
          const request = await tx.caseRequest.create({
            data: {
              caseFileId: file.id,
              type: CaseRequestType.AUCTION,
              number,
              status: CaseRequestStatus.OPEN,
              formationStep: 0,
              intakeSubmittedAt: new Date(),
            },
            select: { id: true },
          });
          await tx.caseRequestEvent.create({
            data: { requestId: request.id, toStatus: CaseRequestStatus.OPEN, actorId: userId },
          });
          await tx.caseAuction.create({
            data: {
              requestId: request.id,
              title: dto.title ?? null,
              startsAt: parseDate(dto.startsAt),
              endsAt: parseDate(dto.endsAt),
              discountMin: dto.discountMin,
              discountMax: dto.discountMax,
              items: {
                create: dto.items.map((item, index) => ({
                  name: item.name.trim(),
                  price: item.price,
                  discountPercent: item.discountPercent,
                  sortOrder: index,
                })),
              },
              approvals: { create: APPROVER_KINDS.map((kind) => ({ kind })) },
            },
          });
          return this.present(tx, userId, file.id, request.id);
        });
      } catch (error) {
        if (!isUniqueConflict(error)) throw error;
      }
    }
    throw new ConflictException('صدور شماره درخواست انجام نشد');
  }

  async update(userId: string, caseId: string, requestId: string, dto: SavePortalAuctionDto) {
    await this.ownedCase(userId, caseId);
    assertRange(dto);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "case_auction_approvals" WHERE "requestId" = ${requestId} FOR UPDATE`;
      const current = await this.load(tx, userId, caseId, requestId);
      if (!(await this.canUpdate(tx, current.request.status, current.approvals, requestId))) {
        throw new BadRequestException('پس از ثبت نظر، ویرایش درخواست ممکن نیست');
      }
      await this.assertNoOverlap(tx, current.request.caseFile.userId, dto.startsAt, dto.endsAt, requestId);
      await tx.caseAuction.update({
        where: { requestId },
        data: {
          title: dto.title ?? null,
          startsAt: parseDate(dto.startsAt),
          endsAt: parseDate(dto.endsAt),
          discountMin: dto.discountMin,
          discountMax: dto.discountMax,
        },
      });
      await tx.caseAuctionItem.deleteMany({ where: { requestId } });
      await tx.caseAuctionItem.createMany({
        data: dto.items.map((item, index) => ({
          requestId,
          name: item.name.trim(),
          price: item.price,
          discountPercent: item.discountPercent,
          sortOrder: index,
        })),
      });
      return this.present(tx, userId, caseId, requestId);
    });
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
          caseRequest: { type: CaseRequestType.AUCTION },
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
          caseRequest: { type: CaseRequestType.AUCTION },
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

  async reviewFile(userId: string, caseId: string, requestId: string, reviewId: string, fileId: string) {
    const file = await this.prisma.caseManagementReviewFile.findFirst({
      where: {
        id: fileId,
        reviewId,
        review: {
          id: reviewId,
          caseFileId: caseId,
          caseRequestId: requestId,
          caseFile: { userId },
          caseRequest: { type: CaseRequestType.AUCTION },
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
    const data = await readStoredBytes(file.storageKey, this.config.getOrThrow<string>('storage.root'));
    return { ...file, data };
  }

  private async ownedCase(userId: string, caseId: string) {
    const file = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId, kind: CaseFileKind.LICENSE },
      select: {
        id: true,
        userId: true,
        status: true,
        licenseNumber: true,
        kind: true,
      },
    });
    if (!file) throw new NotFoundException('پرونده یافت نشد');
    return file;
  }

  private assertCanStart(file: { status: CaseFileStatus; licenseNumber: string | null }) {
    if (file.status === CaseFileStatus.REVOKED) {
      throw new BadRequestException('روی پرونده ابطال‌شده درخواست جدید ثبت نمی‌شود');
    }
    if (file.status === CaseFileStatus.EXPIRED) {
      throw new BadRequestException('روی پرونده منقضی‌شده درخواست حراج ثبت نمی‌شود');
    }
    if (!file.licenseNumber) {
      throw new BadRequestException('قبل از مجوز حراج باید مجوز فعالیت اقتصادی صادر شده باشد');
    }
  }

  private async assertNoOverlap(db: Db, userId: string, startsAt: string, endsAt: string, exceptRequestId?: string) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0::bigint))`;
    const overlap = await db.caseAuction.findFirst({
      where: {
        requestId: exceptRequestId ? { not: exceptRequestId } : undefined,
        startsAt: { lte: parseDate(endsAt) },
        endsAt: { gte: parseDate(startsAt) },
        request: {
          type: CaseRequestType.AUCTION,
          status: { in: OCCUPIED_STATUSES },
          caseFile: { userId },
        },
      },
      select: { requestId: true },
    });
    if (overlap) {
      throw new BadRequestException('برای این شخص در این بازه، درخواست حراج دیگری ثبت شده است');
    }
  }

  private async load(db: Db, userId: string, caseId: string, requestId: string) {
    const auction = await db.caseAuction.findUnique({
      where: { requestId },
      include: {
        ...auctionInclude,
        request: {
          select: {
            id: true,
            caseFileId: true,
            number: true,
            type: true,
            status: true,
            formationStep: true,
            intakeSubmittedAt: true,
            caseFile: {
              select: {
                userId: true,
                businessUnitTitle: true,
                licenseNumber: true,
                activityJob: { select: { title: true } },
                user: { select: { firstName: true, lastName: true, fullName: true } },
              },
            },
          },
        },
      },
    });
    if (
      !auction ||
      auction.request.caseFileId !== caseId ||
      auction.request.caseFile.userId !== userId ||
      auction.request.type !== CaseRequestType.AUCTION
    ) {
      throw new NotFoundException('درخواست مجوز حراج یافت نشد');
    }
    return auction;
  }

  private async refreshOpenPhase(db: Db, requestId: string) {
    const request = await db.caseRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        caseFileId: true,
        type: true,
        status: true,
        formationStep: true,
        intakeSubmittedAt: true,
      },
    });
    if (!request || request.type !== CaseRequestType.AUCTION || request.status !== CaseRequestStatus.OPEN) return;
    if (request.intakeSubmittedAt && request.formationStep < 1) return;
    const roles = await db.caseProcessManagementRole.findMany({
      where: { requestType: CaseRequestType.AUCTION },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { roleId: true },
    });
    if (roles.length) {
      await db.caseManagementReview.createMany({
        data: roles.map((item) => ({
          caseFileId: request.caseFileId,
          caseRequestId: request.id,
          roleId: item.roleId,
        })),
        skipDuplicates: true,
      });
    }
    const ready = await this.readyToIssue(db, requestId);
    const next = ready ? 2 : 1;
    if (request.formationStep === next) return;
    await db.caseRequest.update({
      where: { id: request.id },
      data: { formationStep: next },
    });
  }

  private async readyToIssue(db: Db, requestId: string) {
    const roles = await db.caseProcessManagementRole.findMany({
      where: { requestType: CaseRequestType.AUCTION },
      select: { roleId: true },
    });
    if (!roles.length) return true;
    const roleIds = roles.map((item) => item.roleId);
    const [pending, total] = await Promise.all([
      db.caseManagementReview.count({
        where: { caseRequestId: requestId, roleId: { in: roleIds }, status: CaseInquiryStatus.PENDING },
      }),
      db.caseManagementReview.count({
        where: { caseRequestId: requestId, roleId: { in: roleIds } },
      }),
    ]);
    return total >= roles.length && pending === 0;
  }

  private async canUpdate(
    db: Db,
    status: CaseRequestStatus,
    approvals: { status: CaseInquiryStatus }[],
    requestId: string,
  ) {
    if (status !== CaseRequestStatus.OPEN) return false;
    const request = await db.caseRequest.findUnique({
      where: { id: requestId },
      select: { intakeSubmittedAt: true, formationStep: true },
    });
    if (request?.intakeSubmittedAt) return false;
    if (approvals.some((item) => item.status !== CaseInquiryStatus.PENDING)) return false;
    const decided = await db.caseManagementReview.count({
      where: { caseRequestId: requestId, status: { not: CaseInquiryStatus.PENDING } },
    });
    return decided === 0;
  }

  private async present(db: Db, userId: string, caseId: string, requestId: string) {
    const auction = await this.load(db, userId, caseId, requestId);
    const titles = await db.caseProcessManagementRole.findMany({
      where: { requestType: CaseRequestType.AUCTION },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { roleId: true, title: true, role: { select: { id: true, name: true } } },
    });
    const inquirySelect = {
      id: true,
      status: true,
      note: true,
      referredAt: true,
      decidedAt: true,
      decidedBy: { select: { id: true, fullName: true } },
      inquiryCenter: { select: { name: true } },
      files: {
        orderBy: { createdAt: 'asc' as const },
        select: {
          id: true,
          originalName: true,
          mimeType: true,
          byteSize: true,
        },
      },
    };
    const [inquiries, placesReview, reviews] = await Promise.all([
      db.caseInquiry.findMany({
        where: { caseRequestId: requestId },
        orderBy: [{ inquiryCenter: { name: 'asc' } }, { id: 'asc' }],
        select: inquirySelect,
      }),
      db.casePlacesReview.findUnique({
        where: { caseRequestId: requestId },
        select: {
          id: true,
          status: true,
          note: true,
          referredAt: true,
          decidedAt: true,
          decidedBy: { select: { id: true, fullName: true } },
          files: {
            orderBy: { createdAt: 'asc' as const },
            select: {
              id: true,
              originalName: true,
              mimeType: true,
              byteSize: true,
            },
          },
        },
      }),
      db.caseManagementReview.findMany({
      where: { caseRequestId: requestId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        status: true,
        note: true,
        createdAt: true,
        decidedAt: true,
        decidedBy: { select: { id: true, fullName: true } },
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
    }),
    ]);
    const roleIds = [...new Set(reviews.map((item) => item.role.id))];
    const people = roleIds.length
      ? await db.user.findMany({
          where: {
            status: UserStatus.ACTIVE,
            userRoles: { some: { roleId: { in: roleIds } } },
          },
          select: {
            id: true,
            fullName: true,
            userRoles: { select: { roleId: true } },
          },
          orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        })
      : [];
    const titleByRole = new Map(titles.map((item) => [item.roleId, item.title]));
    const person = auction.request.caseFile.user;
    return {
      id: auction.request.id,
      caseId,
      number: auction.request.number,
      status: auction.request.status,
      editable: await this.canUpdate(db, auction.request.status, auction.approvals, requestId),
      phase: auction.request.formationStep,
      intakeSubmittedAt: auction.request.intakeSubmittedAt?.toISOString() ?? null,
      awaitingIntake:
        auction.request.status === CaseRequestStatus.OPEN &&
        Boolean(auction.request.intakeSubmittedAt) &&
        auction.request.formationStep < 1,
      title: auction.title,
      startsAt: dateOnly(auction.startsAt),
      endsAt: dateOnly(auction.endsAt),
      discountMin: asNumber(auction.discountMin),
      discountMax: asNumber(auction.discountMax),
      items: auction.items.map((item) => {
        const price = asNumber(item.price);
        const discountPercent = asNumber(item.discountPercent);
        return {
          id: item.id,
          name: item.name,
          price,
          discountPercent,
          priceAfterDiscount: priceAfterDiscount(price, discountPercent),
        };
      }),
      inquiries: inquiries.map((row) => ({
        id: row.id,
        status: row.status,
        note: row.note,
        referredAt: row.referredAt?.toISOString() ?? null,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decidedBy: row.decidedBy,
        inquiryCenter: row.inquiryCenter,
        files: row.files,
      })),
      placesReview: placesReview
        ? {
            id: placesReview.id,
            status: placesReview.status,
            note: placesReview.note,
            referredAt: placesReview.referredAt?.toISOString() ?? null,
            decidedAt: placesReview.decidedAt?.toISOString() ?? null,
            decidedBy: placesReview.decidedBy,
            files: placesReview.files,
          }
        : null,
      reviews: reviews.map((item) => ({
        id: item.id,
        status: item.status,
        note: item.note,
        referredAt: item.createdAt.toISOString(),
        decidedAt: item.decidedAt?.toISOString() ?? null,
        decidedBy: item.decidedBy,
        title:
          titleByRole.get(item.role.id) ??
          [item.workUnit?.title, item.role.name].filter(Boolean).join(' · '),
        people: people
          .filter((person) => person.userRoles.some((link) => link.roleId === item.role.id))
          .map((person) => ({ id: person.id, fullName: person.fullName })),
        files: item.files,
      })),
      caseFile: {
        businessUnitTitle: auction.request.caseFile.businessUnitTitle,
        licenseNumber: auction.request.caseFile.licenseNumber,
        jobTitle: auction.request.caseFile.activityJob?.title ?? null,
        person: {
          firstName: person.firstName ?? '',
          lastName: person.lastName ?? '',
          fullName: person.fullName ?? [person.firstName, person.lastName].filter(Boolean).join(' '),
        },
      },
    };
  }
}
