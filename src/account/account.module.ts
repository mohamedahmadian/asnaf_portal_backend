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
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import * as bcrypt from 'bcrypt';
import { CurrentUser, PortalUser } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @Matches(/^09\d{9}$/)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(5)
  address?: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}

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
  personType: true,
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
    const account = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.email !== undefined
          ? { email: dto.email.trim().toLowerCase() }
          : {}),
        ...(dto.address !== undefined ? { address: dto.address.trim() } : {}),
      },
      select: accountSelect,
    });
    return safeAccount(account);
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
