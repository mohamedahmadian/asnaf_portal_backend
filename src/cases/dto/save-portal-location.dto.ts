import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export const premiseEstablishments = [
  'INDEPENDENT',
  'COMMERCIAL_COMPLEX',
  'RESIDENTIAL_COMPLEX',
] as const;
export const premiseGeoPositions = ['MAIN_FRONTAGE', 'SIDE_FRONTAGE', 'ALLEY'] as const;
export const premisePublicAccesses = ['MEN', 'WOMEN', 'PUBLIC', 'SEPARATE'] as const;
export const premiseOwnerships = ['OWNED', 'RENTED'] as const;

function textOrNull(value: unknown) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function emptyToNull(value: unknown) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export class SavePortalLocationDto {
  @IsUUID('4')
  caseId: string;

  @IsUUID('4')
  cityId: string;

  @IsIn(premiseEstablishments)
  establishment: (typeof premiseEstablishments)[number];

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsUUID('4')
  complexId?: string | null;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  address: string;

  @IsOptional()
  @Transform(({ value }) => textOrNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  addressEn?: string | null;

  @IsOptional()
  @Transform(({ value }) => textOrNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  plaque?: string | null;

  @IsOptional()
  @Transform(({ value }) => textOrNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  plaqueSeries?: string | null;

  @IsOptional()
  @Transform(({ value }) => textOrNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  floor?: string | null;

  @IsOptional()
  @Transform(({ value }) => textOrNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  unitNo?: string | null;

  @IsOptional()
  @Transform(({ value }) => textOrNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  postalCode?: string | null;

  @IsOptional()
  @Transform(({ value }) => textOrNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  phone?: string | null;

  @IsOptional()
  @Transform(({ value }) => textOrNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  fax?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsIn(premiseGeoPositions)
  geoPosition?: (typeof premiseGeoPositions)[number] | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsIn(premisePublicAccesses)
  publicAccess?: (typeof premisePublicAccesses)[number] | null;

  @IsIn(premiseOwnerships)
  ownership: (typeof premiseOwnerships)[number];

  @IsOptional()
  @Transform(({ value }) => textOrNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  deedNo?: string | null;

  @Transform(({ value }) => {
    if (value === '' || value == null) return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  })
  @IsNumber()
  @Min(0)
  @Max(1000000)
  area: number;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  leaseIssuedAt?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  leaseExpiresAt?: string | null;

  @IsOptional()
  @Transform(({ value }) => textOrNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  leaseAgency?: string | null;

  @IsOptional()
  @Transform(({ value }) => textOrNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  ownerName?: string | null;
}
