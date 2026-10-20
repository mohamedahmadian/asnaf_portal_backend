import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

function latinDigits(value: string) {
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  return value.replace(/[۰-۹٠-٩]/g, (char) => {
    const persianIndex = persian.indexOf(char);
    return String(persianIndex >= 0 ? persianIndex : arabic.indexOf(char));
  });
}

function trimString(value: unknown) {
  return typeof value === 'string' ? value.trim() : value;
}

function emptyToNull(value: unknown) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toPercent(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return value;
  const normalized = latinDigits(value).trim().replace(/,/g, '.').replace(/٬/g, '');
  if (!normalized) return value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : value;
}

function toAmount(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return value;
  const digits = latinDigits(value).replace(/\D/g, '');
  if (!digits || digits.length > 15) return value;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

export class PortalAuctionItemDto {
  @Transform(({ value }) => trimString(value))
  @IsString({ message: 'نام کالا را وارد کنید' })
  @MinLength(1, { message: 'نام کالا را وارد کنید' })
  @MaxLength(200, { message: 'نام کالا طولانی است' })
  name: string;

  @Transform(({ value }) => toAmount(value))
  @Type(() => Number)
  @IsInt({ message: 'قیمت کالا معتبر نیست' })
  @Min(1, { message: 'قیمت کالا باید بیشتر از صفر باشد' })
  @Max(999_999_999_999_999, { message: 'قیمت کالا بزرگ‌تر از حد مجاز است' })
  price: number;

  @Transform(({ value }) => toPercent(value))
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'درصد تخفیف کالا معتبر نیست' })
  @Min(0, { message: 'درصد تخفیف کالا معتبر نیست' })
  @Max(100, { message: 'درصد تخفیف کالا معتبر نیست' })
  discountPercent: number;
}

export class SavePortalAuctionDto {
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsString({ message: 'عنوان مجوز حراج معتبر نیست' })
  @MaxLength(200, { message: 'عنوان مجوز حراج طولانی است' })
  title?: string | null;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'تاریخ شروع حراج معتبر نیست' })
  startsAt: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'تاریخ پایان حراج معتبر نیست' })
  endsAt: string;

  @Transform(({ value }) => toPercent(value))
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'حداقل درصد تخفیف معتبر نیست' })
  @Min(0, { message: 'حداقل درصد تخفیف معتبر نیست' })
  @Max(100, { message: 'حداقل درصد تخفیف معتبر نیست' })
  discountMin: number;

  @Transform(({ value }) => toPercent(value))
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'حداکثر درصد تخفیف معتبر نیست' })
  @Min(0, { message: 'حداکثر درصد تخفیف معتبر نیست' })
  @Max(100, { message: 'حداکثر درصد تخفیف معتبر نیست' })
  discountMax: number;

  @IsArray({ message: 'حداقل یک کالا لازم است' })
  @ArrayMinSize(1, { message: 'حداقل یک کالا لازم است' })
  @ArrayMaxSize(50, { message: 'تعداد کالاها بیش از حد است' })
  @ValidateNested({ each: true })
  @Type(() => PortalAuctionItemDto)
  items: PortalAuctionItemDto[];
}
