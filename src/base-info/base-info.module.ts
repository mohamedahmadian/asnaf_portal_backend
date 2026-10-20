import {
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const sortDirections = ['asc', 'desc'] as const;
const jobTypeSortFields = ['title', 'description', 'annualFee', 'dailyFee'] as const;
const jobGroupSortFields = ['title', 'titleEn', 'code', 'isActive', 'jobCount'] as const;
const jobCatalogSortFields = [
  'title',
  'titleEn',
  'taxIntaCode',
  'jobType',
  'annualFee',
  'group',
  'isActive',
] as const;

function emptyToUndefined(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

class CatalogListQuery {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Transform(({ value }) => (value == null || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => (value == null || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn([...sortDirections])
  sortDir?: (typeof sortDirections)[number];
}

class FindJobTypesQuery extends CatalogListQuery {
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn([...jobTypeSortFields])
  sortBy?: (typeof jobTypeSortFields)[number];
}

class FindJobGroupsQuery extends CatalogListQuery {
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn([...jobGroupSortFields])
  sortBy?: (typeof jobGroupSortFields)[number];
}

class FindJobsQuery extends CatalogListQuery {
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsUUID()
  jobTypeId?: string;

  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsUUID()
  groupId?: string;

  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn([...jobCatalogSortFields])
  sortBy?: (typeof jobCatalogSortFields)[number];
}

function containsInsensitive(q: string) {
  return { contains: q, mode: 'insensitive' as const };
}

function paginationArgs(query: CatalogListQuery) {
  const page = query.page && query.page > 0 ? query.page : 1;
  const pageSize =
    query.pageSize && query.pageSize > 0 ? Math.min(query.pageSize, 100) : 10;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

function wantsPagination(query: CatalogListQuery) {
  return query.page != null || query.pageSize != null;
}

function resolveSortOrder<TOrderBy>(
  sortBy: string | undefined,
  sortDir: (typeof sortDirections)[number] | undefined,
  builders: Record<string, (dir: (typeof sortDirections)[number]) => TOrderBy>,
  fallback: TOrderBy[],
): TOrderBy[] {
  if (!sortBy || (sortDir !== 'asc' && sortDir !== 'desc')) return fallback;
  const build = builders[sortBy];
  if (!build) return fallback;
  return [build(sortDir), ...fallback];
}

function toFeeNumber(value: Prisma.Decimal | number | null) {
  if (value == null) return null;
  return typeof value === 'number' ? value : Number(value);
}

const jobTypeSelect = {
  id: true,
  title: true,
  description: true,
  annualFee: true,
} satisfies Prisma.JobTypeSelect;

const jobGroupSelect = {
  id: true,
  title: true,
  titleEn: true,
  description: true,
  code: true,
  isActive: true,
  _count: { select: { jobs: true } },
} satisfies Prisma.JobGroupSelect;

const jobSelect = {
  id: true,
  groupId: true,
  title: true,
  titleEn: true,
  taxIntaCode: true,
  description: true,
  code: true,
  jobTypeId: true,
  annualFee: true,
  isActive: true,
  jobType: { select: { id: true, title: true } },
  group: { select: { id: true, title: true, titleEn: true, code: true, isActive: true } },
} satisfies Prisma.JobSelect;

@Injectable()
class BaseInfoService {
  constructor(private readonly prisma: PrismaService) {}

  async jobTypes(query: FindJobTypesQuery) {
    const term = query.q?.trim();
    const where: Prisma.JobTypeWhereInput = {
      OR: term
        ? [{ title: containsInsensitive(term) }, { description: containsInsensitive(term) }]
        : undefined,
    };
    const orderBy = resolveSortOrder<Prisma.JobTypeOrderByWithRelationInput>(
      query.sortBy,
      query.sortDir,
      {
        title: (dir) => ({ title: dir }),
        description: (dir) => ({ description: dir }),
        annualFee: (dir) => ({ annualFee: dir }),
        dailyFee: (dir) => ({ annualFee: dir }),
      },
      [{ createdAt: 'asc' }, { id: 'asc' }],
    );
    if (!wantsPagination(query)) {
      const items = await this.prisma.jobType.findMany({ where, orderBy, select: jobTypeSelect });
      return items.map((item) => ({ ...item, annualFee: toFeeNumber(item.annualFee) }));
    }
    const { page, pageSize, skip, take } = paginationArgs(query);
    const [items, total] = await Promise.all([
      this.prisma.jobType.findMany({ where, orderBy, skip, take, select: jobTypeSelect }),
      this.prisma.jobType.count({ where }),
    ]);
    return {
      items: items.map((item) => ({ ...item, annualFee: toFeeNumber(item.annualFee) })),
      total,
      page,
      pageSize,
    };
  }

  async jobType(id: string) {
    const item = await this.prisma.jobType.findUnique({ where: { id }, select: jobTypeSelect });
    if (!item) throw new NotFoundException('نوع خدمات یافت نشد');
    return { ...item, annualFee: toFeeNumber(item.annualFee) };
  }

  async jobGroups(query: FindJobGroupsQuery) {
    const term = query.q?.trim();
    const where: Prisma.JobGroupWhereInput = {
      OR: term
        ? [
            { title: containsInsensitive(term) },
            { titleEn: containsInsensitive(term) },
            { description: containsInsensitive(term) },
            { code: containsInsensitive(term) },
          ]
        : undefined,
    };
    const orderBy = resolveSortOrder<Prisma.JobGroupOrderByWithRelationInput>(
      query.sortBy,
      query.sortDir,
      {
        title: (dir) => ({ title: dir }),
        titleEn: (dir) => ({ titleEn: dir }),
        code: (dir) => ({ code: dir }),
        isActive: (dir) => ({ isActive: dir }),
        jobCount: (dir) => ({ jobs: { _count: dir } }),
      },
      [{ createdAt: 'desc' }, { id: 'asc' }],
    );
    if (!wantsPagination(query)) {
      return this.prisma.jobGroup.findMany({ where, orderBy, select: jobGroupSelect });
    }
    const { page, pageSize, skip, take } = paginationArgs(query);
    const [items, total] = await Promise.all([
      this.prisma.jobGroup.findMany({ where, orderBy, skip, take, select: jobGroupSelect }),
      this.prisma.jobGroup.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async jobGroup(id: string) {
    const item = await this.prisma.jobGroup.findUnique({ where: { id }, select: jobGroupSelect });
    if (!item) throw new NotFoundException('گروه شغلی یافت نشد');
    return item;
  }

  async jobs(query: FindJobsQuery) {
    const term = query.q?.trim();
    const where: Prisma.JobWhereInput = {
      jobTypeId: query.jobTypeId,
      groupId: query.groupId,
      OR: term
        ? [
            { title: containsInsensitive(term) },
            { titleEn: containsInsensitive(term) },
            { taxIntaCode: containsInsensitive(term) },
            { jobType: { is: { title: containsInsensitive(term) } } },
            { group: { is: { title: containsInsensitive(term) } } },
            { group: { is: { titleEn: containsInsensitive(term) } } },
          ]
        : undefined,
    };
    const orderBy = resolveSortOrder<Prisma.JobOrderByWithRelationInput>(
      query.sortBy,
      query.sortDir,
      {
        title: (dir) => ({ title: dir }),
        titleEn: (dir) => ({ titleEn: dir }),
        taxIntaCode: (dir) => ({ taxIntaCode: dir }),
        jobType: (dir) => ({ jobType: { title: dir } }),
        annualFee: (dir) => ({ annualFee: dir }),
        group: (dir) => ({ group: { title: dir } }),
        isActive: (dir) => ({ isActive: dir }),
      },
      [{ createdAt: 'desc' }, { id: 'asc' }],
    );
    if (!wantsPagination(query)) {
      const items = await this.prisma.job.findMany({ where, orderBy, select: jobSelect });
      return items.map((item) => ({ ...item, annualFee: toFeeNumber(item.annualFee) }));
    }
    const { page, pageSize, skip, take } = paginationArgs(query);
    const [items, total] = await Promise.all([
      this.prisma.job.findMany({ where, orderBy, skip, take, select: jobSelect }),
      this.prisma.job.count({ where }),
    ]);
    return {
      items: items.map((item) => ({ ...item, annualFee: toFeeNumber(item.annualFee) })),
      total,
      page,
      pageSize,
    };
  }

  async job(id: string) {
    const item = await this.prisma.job.findUnique({ where: { id }, select: jobSelect });
    if (!item) throw new NotFoundException('شغل یافت نشد');
    return { ...item, annualFee: toFeeNumber(item.annualFee) };
  }

  async jobStats() {
    const [jobCount, jobGroupCount, grouped, types] = await Promise.all([
      this.prisma.job.count(),
      this.prisma.jobGroup.count(),
      this.prisma.job.groupBy({ by: ['jobTypeId'], _count: { _all: true } }),
      this.prisma.jobType.findMany({ select: { id: true, title: true }, orderBy: { title: 'asc' } }),
    ]);
    const counts = new Map(grouped.map((row) => [row.jobTypeId, row._count._all]));
    const byJobType = types
      .map((type) => ({ id: type.id, title: type.title, count: counts.get(type.id) ?? 0 }))
      .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title, 'fa'));
    return { jobCount, jobGroupCount, byJobType };
  }
}

@Controller('base-info')
class BaseInfoController {
  constructor(private readonly catalog: BaseInfoService) {}

  @Get('job-types')
  jobTypes(@Query() query: FindJobTypesQuery) {
    return this.catalog.jobTypes(query);
  }

  @Get('job-types/:id')
  jobType(@Param('id') id: string) {
    return this.catalog.jobType(id);
  }

  @Get('job-groups')
  jobGroups(@Query() query: FindJobGroupsQuery) {
    return this.catalog.jobGroups(query);
  }

  @Get('job-groups/:id')
  jobGroup(@Param('id') id: string) {
    return this.catalog.jobGroup(id);
  }

  @Get('jobs/stats')
  jobStats() {
    return this.catalog.jobStats();
  }

  @Get('jobs')
  jobs(@Query() query: FindJobsQuery) {
    return this.catalog.jobs(query);
  }

  @Get('jobs/:id')
  job(@Param('id') id: string) {
    return this.catalog.job(id);
  }
}

@Module({
  controllers: [BaseInfoController],
  providers: [BaseInfoService],
})
export class BaseInfoModule {}
