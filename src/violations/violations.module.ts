import {
  Controller,
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
import { CurrentUser, PortalUser } from '../auth/auth.module';
import { Prisma, ViolationStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const VIOLATION_STATUSES = [
  'REGISTERED',
  'UNDER_REVIEW',
  'NOTICE',
  'REFERRED',
  'VERDICT_ISSUED',
  'CLOSED',
  'DISMISSED',
] as const satisfies readonly ViolationStatus[];

const VIOLATION_SORTS = [
  'violationType',
  'businessUnitTitle',
  'licenseNumber',
  'occurredAt',
  'status',
] as const;

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

const violationSelect = {
  id: true,
  nationalId: true,
  occurredAt: true,
  description: true,
  status: true,
  violationType: { select: { id: true, title: true } },
  caseFile: {
    select: { id: true, businessUnitTitle: true, licenseNumber: true },
  },
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

const listSelect = {
  id: true,
  occurredAt: true,
  status: true,
  violationType: { select: { id: true, title: true } },
  caseFile: {
    select: { id: true, businessUnitTitle: true, licenseNumber: true },
  },
} satisfies Prisma.ViolationSelect;

function mapCaseFile(
  caseFile: {
    id: string;
    businessUnitTitle: string | null;
    licenseNumber: string | null;
  } | null,
) {
  if (!caseFile) return null;
  return {
    id: caseFile.id,
    businessUnitTitle: caseFile.businessUnitTitle,
    licenseNumber: caseFile.licenseNumber,
  };
}

function mapViolation(
  item: Prisma.ViolationGetPayload<{ select: typeof violationSelect }>,
) {
  return {
    id: item.id,
    nationalId: item.nationalId,
    description: item.description,
    status: item.status,
    violationType: item.violationType,
    caseFile: mapCaseFile(item.caseFile),
    occurredAt: dateOnly(item.occurredAt),
    attachments: item.attachments.map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      originalName: attachment.originalName,
      mimeType: attachment.file?.mimeType ?? attachment.image?.mimeType ?? null,
    })),
  };
}

function listOrder(
  sortBy: (typeof VIOLATION_SORTS)[number] | undefined,
  sortDir: 'asc' | 'desc' | undefined,
): Prisma.ViolationOrderByWithRelationInput[] {
  const dir = sortDir === 'asc' ? 'asc' : 'desc';
  const tie = { id: 'asc' as const };
  switch (sortBy) {
    case 'violationType':
      return [{ violationType: { title: dir } }, tie];
    case 'businessUnitTitle':
      return [{ caseFile: { businessUnitTitle: dir } }, tie];
    case 'licenseNumber':
      return [{ caseFile: { licenseNumber: dir } }, tie];
    case 'status':
      return [{ status: dir }, tie];
    case 'occurredAt':
      return [{ occurredAt: dir }, { createdAt: 'desc' }, tie];
    default:
      return [{ occurredAt: 'desc' }, { createdAt: 'desc' }, tie];
  }
}

export class ViolationListQuery {
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
  @IsIn(VIOLATION_SORTS)
  sortBy?: (typeof VIOLATION_SORTS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  @IsOptional()
  @IsIn(VIOLATION_STATUSES)
  status?: (typeof VIOLATION_STATUSES)[number];
}

@Injectable()
export class ViolationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, query: ViolationListQuery) {
    const nationalId = await this.nationalIdOf(userId);
    if (!nationalId) {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    }
    const where = this.where(nationalId, query);
    const [total, rows] = await Promise.all([
      this.prisma.violation.count({ where }),
      this.prisma.violation.findMany({
        where,
        orderBy: listOrder(query.sortBy, query.sortDir),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: listSelect,
      }),
    ]);
    return {
      items: rows.map((item) => ({
        id: item.id,
        status: item.status,
        violationType: item.violationType,
        caseFile: mapCaseFile(item.caseFile),
        occurredAt: dateOnly(item.occurredAt),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findOne(userId: string, violationId: string) {
    const nationalId = await this.nationalIdOf(userId);
    if (!nationalId) throw new NotFoundException('تخلف یافت نشد');
    const item = await this.prisma.violation.findFirst({
      where: { id: violationId, nationalId },
      select: violationSelect,
    });
    if (!item) throw new NotFoundException('تخلف یافت نشد');
    return mapViolation(item);
  }

  async attachment(userId: string, violationId: string, attachmentId: string) {
    const nationalId = await this.nationalIdOf(userId);
    if (!nationalId) throw new NotFoundException('پیوست یافت نشد');
    const attachment = await this.prisma.violationAttachment.findFirst({
      where: {
        id: attachmentId,
        violationId,
        violation: { nationalId },
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

  private async nationalIdOf(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { nationalId: true },
    });
    const nationalId = user?.nationalId?.trim();
    return nationalId || null;
  }

  private where(nationalId: string, query: ViolationListQuery): Prisma.ViolationWhereInput {
    const q = query.q?.trim();
    const digits = q ? latinDigits(q).replace(/\D/g, '') : '';
    return {
      nationalId,
      ...(query.status ? { status: query.status } : {}),
      ...(q
        ? {
            OR: [
              { violationType: { title: { contains: q, mode: 'insensitive' } } },
              { description: { contains: q, mode: 'insensitive' } },
              { caseFile: { businessUnitTitle: { contains: q, mode: 'insensitive' } } },
              { caseFile: { licenseNumber: { contains: q, mode: 'insensitive' } } },
              ...(digits
                ? [{ caseFile: { licenseNumber: { contains: digits } } }]
                : []),
            ],
          }
        : {}),
    };
  }
}

@Controller('violations')
export class ViolationsController {
  constructor(private readonly violations: ViolationsService) {}

  @Get()
  list(@CurrentUser() user: PortalUser, @Query() query: ViolationListQuery) {
    return this.violations.list(user.id, query);
  }

  @Get(':id/attachments/:attachmentId')
  async attachment(
    @CurrentUser() user: PortalUser,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Res() response: Response,
  ) {
    const file = await this.violations.attachment(user.id, id, attachmentId);
    const ascii = file.name.replace(/[^\w.\-]+/g, '_') || 'file';
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', String(file.data.length));
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    response.send(file.data);
  }

  @Get(':id')
  findOne(@CurrentUser() user: PortalUser, @Param('id') id: string) {
    return this.violations.findOne(user.id, id);
  }
}

@Module({
  controllers: [ViolationsController],
  providers: [ViolationsService],
})
export class ViolationsModule {}
