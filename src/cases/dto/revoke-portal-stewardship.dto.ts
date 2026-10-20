import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RevokePortalStewardshipDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'متن درخواست را وارد کنید' })
  @MinLength(1, { message: 'متن درخواست را وارد کنید' })
  @MaxLength(8000, { message: 'متن درخواست طولانی است' })
  reason: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'تاریخ ابطال مباشرت معتبر نیست' })
  revokedAt?: string;
}
