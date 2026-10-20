import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MinLength,
  ValidateIf,
} from 'class-validator';
import * as bcrypt from 'bcrypt';
import { CurrentUser, PortalUser } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';

function emptyToNull(value: unknown) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @Matches(/^09\d{9}$/)
  phone?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim().toLowerCase();
    return trimmed || null;
  })
  @ValidateIf((_, value) => value != null)
  @IsEmail()
  email?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  @MinLength(5)
  address?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  birthPlace?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  postalCode?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  homePhone?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  telegram?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  bale?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  eitaa?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  whatsapp?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  otherSocial?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsString()
  notes?: string | null;

  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return value;
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  })
  @IsString({ each: true })
  vehiclePlates?: string[];

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsUUID('4')
  countryId?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsUUID('4')
  provinceId?: string | null;

  @IsOptional()
  @Transform(({ value }) => emptyToNull(value))
  @ValidateIf((_, value) => value != null)
  @IsUUID('4')
  cityId?: string | null;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}

const geoSelect = { id: true, nameFa: true } as const;

const accountSelect = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  fullName: true,
  nationalId: true,
  phone: true,
  email: true,
  address: true,
  postalCode: true,
  homePhone: true,
  gender: true,
  birthDate: true,
  birthPlace: true,
  personType: true,
  notes: true,
  telegram: true,
  bale: true,
  eitaa: true,
  whatsapp: true,
  otherSocial: true,
  vehiclePlates: true,
  countryId: true,
  provinceId: true,
  cityId: true,
  country: { select: geoSelect },
  province: { select: geoSelect },
  city: { select: geoSelect },
  photoId: true,
} as const;

function safeAccount<T extends { photoId: string | null }>(account: T) {
  const { photoId, ...fields } = account;
  return { ...fields, hasPhoto: Boolean(photoId) };
}

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string) {
    const account = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: accountSelect,
    });
    return safeAccount(account);
  }

  async update(userId: string, dto: UpdateAccountDto) {
    if (dto.phone) {
      const duplicate = await this.prisma.user.findFirst({
        where: { phone: dto.phone, id: { not: userId } },
        select: { id: true },
      });
      if (duplicate)
        throw new BadRequestException('این تلفن همراه قبلاً ثبت شده است');
    }
    if (dto.email) {
      const duplicate = await this.prisma.user.findFirst({
        where: { email: dto.email, id: { not: userId } },
        select: { id: true },
      });
      if (duplicate) throw new BadRequestException('این ایمیل قبلاً ثبت شده است');
    }
    if (dto.countryId !== undefined || dto.provinceId !== undefined || dto.cityId !== undefined) {
      await this.assertGeo(dto.countryId, dto.provinceId, dto.cityId);
    }
    const account = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.birthPlace !== undefined ? { birthPlace: dto.birthPlace } : {}),
        ...(dto.postalCode !== undefined ? { postalCode: dto.postalCode } : {}),
        ...(dto.homePhone !== undefined ? { homePhone: dto.homePhone } : {}),
        ...(dto.telegram !== undefined ? { telegram: dto.telegram } : {}),
        ...(dto.bale !== undefined ? { bale: dto.bale } : {}),
        ...(dto.eitaa !== undefined ? { eitaa: dto.eitaa } : {}),
        ...(dto.whatsapp !== undefined ? { whatsapp: dto.whatsapp } : {}),
        ...(dto.otherSocial !== undefined ? { otherSocial: dto.otherSocial } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.vehiclePlates !== undefined ? { vehiclePlates: dto.vehiclePlates } : {}),
        ...(dto.countryId !== undefined ? { countryId: dto.countryId } : {}),
        ...(dto.provinceId !== undefined ? { provinceId: dto.provinceId } : {}),
        ...(dto.cityId !== undefined ? { cityId: dto.cityId } : {}),
      },
      select: accountSelect,
    });
    return safeAccount(account);
  }

  private async assertGeo(
    countryId?: string | null,
    provinceId?: string | null,
    cityId?: string | null,
  ) {
    if (countryId) {
      const country = await this.prisma.country.findUnique({ where: { id: countryId } });
      if (!country) throw new BadRequestException('کشور معتبر نیست');
    }
    if (provinceId) {
      const province = await this.prisma.province.findUnique({ where: { id: provinceId } });
      if (!province) throw new BadRequestException('استان معتبر نیست');
      if (countryId && province.countryId !== countryId) {
        throw new BadRequestException('استان متعلق به این کشور نیست');
      }
    }
    if (cityId) {
      const city = await this.prisma.city.findUnique({ where: { id: cityId } });
      if (!city) throw new BadRequestException('شهر معتبر نیست');
      if (provinceId && city.provinceId !== provinceId) {
        throw new BadRequestException('شهر متعلق به این استان نیست');
      }
    }
  }

  async getPhoto(userId: string) {
    const owner = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        photo: {
          select: {
            data: true,
            mimeType: true,
            originalName: true,
          },
        },
      },
    });
    if (!owner?.photo) throw new NotFoundException();
    return owner.photo;
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new BadRequestException('رمز عبور فعلی نادرست است');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('رمز عبور جدید باید متفاوت باشد');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 12) },
    });
    return { changed: true };
  }
}

@Controller('account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get()
  get(@CurrentUser() user: PortalUser) {
    return this.account.get(user.id);
  }

  @Patch()
  update(@CurrentUser() user: PortalUser, @Body() dto: UpdateAccountDto) {
    return this.account.update(user.id, dto);
  }

  @Get('photo')
  async photo(@CurrentUser() user: PortalUser, @Res() res: Response) {
    const photo = await this.account.getPhoto(user.id);
    const ext =
      photo.mimeType === 'image/png'
        ? 'png'
        : photo.mimeType === 'image/jpeg'
          ? 'jpg'
          : 'bin';
    const name = photo.originalName?.trim() || `profile.${ext}`;
    const ascii = name.replace(/[^\w.\-]+/g, '_') || `profile.${ext}`;
    res.setHeader('Content-Type', photo.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    res.send(Buffer.from(photo.data));
  }

  @Post('password')
  password(@CurrentUser() user: PortalUser, @Body() dto: ChangePasswordDto) {
    return this.account.changePassword(user.id, dto);
  }
}

@Module({
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
