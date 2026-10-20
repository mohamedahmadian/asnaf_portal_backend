import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';
import { toLatinDigits } from '../../auth/identity';

function latinDigits(value: unknown) {
  return typeof value === 'string' ? toLatinDigits(value).replace(/\D/g, '') : value;
}

function optionalPhone(value: unknown) {
  const digits = latinDigits(value);
  return typeof digits === 'string' && digits ? digits : undefined;
}

export class CreatePortalStewardDto {
  @Transform(({ value }) => latinDigits(value))
  @IsString()
  @Matches(/^\d{10}$/, { message: 'کد ملی معتبر نیست' })
  nationalId: string;

  @Transform(({ value }) => optionalPhone(value))
  @IsOptional()
  @IsString()
  @Matches(/^09\d{9}$/, { message: 'شماره همراه معتبر نیست' })
  phone?: string;
}
