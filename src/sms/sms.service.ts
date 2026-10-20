import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { phoneLookupValues } from '../auth/identity';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MySmsListQuery, smsSortFields } from './dto/my-sms-list.query';

export type SendSmsInput = {
  phone: string;
  body: string;
  source?: 'MANUAL' | 'PASSWORD' | 'PAYMENT_LINK' | 'STEWARDSHIP';
};

const messageSelect = {
  id: true,
  phone: true,
  body: true,
  status: true,
  source: true,
  createdAt: true,
} satisfies Prisma.SmsMessageSelect;

function listOrder(
  sortBy: (typeof smsSortFields)[number] | undefined,
  sortDir: 'asc' | 'desc' | undefined,
): Prisma.SmsMessageOrderByWithRelationInput[] {
  const dir = sortDir === 'asc' ? 'asc' : 'desc';
  const tie = { id: 'asc' as const };
  switch (sortBy) {
    case 'status':
      return [{ status: dir }, tie];
    case 'source':
      return [{ source: dir }, tie];
    case 'createdAt':
      return [{ createdAt: dir }, tie];
    default:
      return [{ createdAt: 'desc' }, tie];
  }
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * ارسال واقعی به درگاه هنوز وصل نیست.
   * هر دستور ارسال در تاریخچهٔ مشترک ثبت می‌شود.
   */
  async send(input: SendSmsInput) {
    this.logger.warn(
      `SMS mock. Would send to ${input.phone} (${input.body.length} chars)`,
    );
    await this.prisma.smsMessage.create({
      data: {
        phone: input.phone,
        body: input.body,
        source: input.source ?? 'MANUAL',
        status: 'SKIPPED',
      },
    });
    return { mocked: true, skipped: true };
  }

  async listMine(userId: string, query: MySmsListQuery) {
    const phones = await this.phonesOf(userId);
    if (!phones.length) {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    }
    const where = this.where(phones, query);
    const [total, rows] = await Promise.all([
      this.prisma.smsMessage.count({ where }),
      this.prisma.smsMessage.findMany({
        where,
        orderBy: listOrder(query.sortBy, query.sortDir),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: messageSelect,
      }),
    ]);
    return { items: rows, total, page: query.page, pageSize: query.pageSize };
  }

  async findMine(userId: string, id: string) {
    const phones = await this.phonesOf(userId);
    if (!phones.length) throw new NotFoundException('پیامک یافت نشد');
    const item = await this.prisma.smsMessage.findFirst({
      where: { id, phone: { in: phones } },
      select: messageSelect,
    });
    if (!item) throw new NotFoundException('پیامک یافت نشد');
    return item;
  }

  private async phonesOf(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    const phone = user?.phone?.trim();
    if (!phone) return [];
    const values = phoneLookupValues(phone);
    return values.length ? values : [phone];
  }

  private where(
    phones: string[],
    query: MySmsListQuery,
  ): Prisma.SmsMessageWhereInput {
    const q = query.q?.trim();
    return {
      phone: { in: phones },
      ...(query.status ? { status: query.status } : {}),
      ...(q
        ? {
            body: { contains: q, mode: 'insensitive' },
          }
        : {}),
    };
  }
}
