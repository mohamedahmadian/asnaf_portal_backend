import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const smsStatuses = ['SKIPPED', 'SENT', 'FAILED'] as const;
export const smsSortFields = ['createdAt', 'status', 'source'] as const;

function emptyToUndefined(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export class MySmsListQuery {
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
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn([...smsSortFields])
  sortBy?: (typeof smsSortFields)[number];

  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn([...smsStatuses])
  status?: (typeof smsStatuses)[number];
}
