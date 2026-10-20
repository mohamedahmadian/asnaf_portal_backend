import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  createParamDecorator,
  ExecutionContext,
  Get,
  Injectable,
  Logger,
  Module,
  Post,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AuthGuard, PassportModule } from '@nestjs/passport';
import { PassportStrategy } from '@nestjs/passport';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches, MinLength } from 'class-validator';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as bcrypt from 'bcrypt';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  isValidIranianNationalId,
  joinFullName,
  normalizeMobile,
  normalizeNationalId,
  phoneLookupValues,
  randomTempPassword,
  toLatinDigits,
} from './identity';

export const ECONOMIC_ACTOR_ROLE = 'ECONOMIC_ACTOR';
const PUBLIC_ROUTE = 'portal:public';

export type PortalUser = {
  id: string;
  username: string;
  fullName: string;
  nationalId: string | null;
  phone: string | null;
  hasPhoto: boolean;
};

type PortalUserRecord = Omit<PortalUser, 'hasPhoto'> & {
  photoId: string | null;
};

function toPortalUser(user: PortalUserRecord): PortalUser {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    nationalId: user.nationalId,
    phone: user.phone,
    hasPhoto: Boolean(user.photoId),
  };
}

export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PortalUser =>
    context.switchToHttp().getRequest<{ user: PortalUser }>().user,
);

export const forgotPasswordChannels = ['sms', 'email'] as const;
export type ForgotPasswordChannel = (typeof forgotPasswordChannels)[number];

export class LoginDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? toLatinDigits(value.trim()) : value,
  )
  @IsString()
  @MinLength(1)
  identifier: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? toLatinDigits(value) : value,
  )
  @IsString()
  @MinLength(1)
  password: string;
}

export class ForgotPasswordDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? toLatinDigits(value.trim()) : value,
  )
  @IsString()
  @MinLength(3)
  identifier: string;

  @IsIn([...forgotPasswordChannels])
  channel: ForgotPasswordChannel;
}

export class RegisterEconomicActorDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  firstName: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  lastName: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeNationalId(value) : value,
  )
  @IsString()
  @Matches(/^\d{10}$/, { message: 'کد ملی معتبر نیست' })
  nationalId: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeMobile(value) : value,
  )
  @Matches(/^09\d{9}$/, { message: 'شماره همراه معتبر نیست' })
  phone: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? toLatinDigits(value) : value,
  )
  @IsString()
  @MinLength(8, { message: 'رمز عبور باید حداقل ۸ کاراکتر باشد' })
  password: string;
}

@Injectable()
export class PortalJwtStrategy extends PassportStrategy(
  Strategy,
  'portal-jwt',
) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('auth.secret'),
      audience: config.getOrThrow<string>('auth.audience'),
      issuer: config.getOrThrow<string>('auth.issuer'),
      algorithms: ['HS256'],
    });
  }

  async validate(payload: { sub?: string; typ?: string }): Promise<PortalUser> {
    if (!payload.sub || payload.typ !== 'portal-access') {
      throw new UnauthorizedException();
    }
    const user = await this.prisma.user.findFirst({
      where: {
        id: payload.sub,
        status: 'ACTIVE',
        userRoles: { some: { role: { code: ECONOMIC_ACTOR_ROLE } } },
      },
      select: {
        id: true,
        username: true,
        fullName: true,
        nationalId: true,
        phone: true,
        photoId: true,
      },
    });
    if (!user) throw new UnauthorizedException();
    return toPortalUser(user);
  }
}

@Injectable()
export class PortalAuthGuard extends AuthGuard('portal-jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    return super.canActivate(context);
  }
}

const actorRoleWhere = {
  userRoles: { some: { role: { code: ECONOMIC_ACTOR_ROLE } } },
} as const;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.findActiveEconomicActor(dto.identifier);
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('نام کاربری یا رمز عبور نادرست است');
    }
    return this.issueSession(user);
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.findActiveEconomicActor(dto.identifier);
    if (!user) {
      return { status: 'not_found' as const };
    }
    if (dto.channel === 'email') {
      return { status: 'no_email' as const };
    }
    if (!user.phone?.trim()) {
      return { status: 'no_phone' as const };
    }
    const password = randomTempPassword();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(password, 12) },
    });
    this.logger.warn(
      `SMS mock. Would send temporary password to ${user.phone} (${password.length} chars)`,
    );
    return { status: 'sent' as const };
  }

  async register(dto: RegisterEconomicActorDto) {
    if (!isValidIranianNationalId(dto.nationalId)) {
      throw new BadRequestException('کد ملی معتبر نیست');
    }
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [
          { nationalId: dto.nationalId },
          { username: dto.nationalId },
          { phone: dto.phone },
        ],
      },
      select: { nationalId: true, username: true, phone: true },
    });
    if (existing) {
      if (existing.phone === dto.phone) {
        throw new ConflictException('این تلفن همراه قبلاً ثبت شده است');
      }
      throw new ConflictException('این کد ملی قبلاً ثبت شده است');
    }
    const role = await this.ensureEconomicActorRole();
    const user = await this.prisma.user.create({
      data: {
        username: dto.nationalId,
        passwordHash: await bcrypt.hash(dto.password, 12),
        firstName: dto.firstName,
        lastName: dto.lastName,
        fullName: joinFullName(dto.firstName, dto.lastName),
        nationalId: dto.nationalId,
        phone: dto.phone,
        locale: 'fa',
        status: 'ACTIVE',
        userRoles: { create: { roleId: role.id } },
      },
      select: {
        id: true,
        username: true,
        fullName: true,
        nationalId: true,
        phone: true,
        photoId: true,
      },
    });
    return this.issueSession(user);
  }

  private async issueSession(user: PortalUserRecord) {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, typ: 'portal-access' },
      {
        secret: this.config.getOrThrow<string>('auth.secret'),
        audience: this.config.getOrThrow<string>('auth.audience'),
        issuer: this.config.getOrThrow<string>('auth.issuer'),
        algorithm: 'HS256',
        expiresIn: '8h',
      },
    );
    return {
      accessToken,
      user: toPortalUser(user),
    };
  }

  private async findActiveEconomicActor(identifier: string) {
    const value = toLatinDigits(identifier.trim());
    const nationalId = normalizeNationalId(value);
    const or: Prisma.UserWhereInput[] = [{ username: value }];
    if (nationalId) or.push({ nationalId });
    for (const phone of phoneLookupValues(value)) {
      or.push({ phone });
    }
    return this.prisma.user.findFirst({
      where: {
        status: 'ACTIVE',
        OR: or,
        ...actorRoleWhere,
      },
      select: {
        id: true,
        username: true,
        passwordHash: true,
        fullName: true,
        nationalId: true,
        phone: true,
        photoId: true,
      },
    });
  }

  private async ensureEconomicActorRole() {
    return this.prisma.role.upsert({
      where: { code: ECONOMIC_ACTOR_ROLE },
      update: { isSystem: true },
      create: {
        code: ECONOMIC_ACTOR_ROLE,
        name: 'فعال اقتصادی',
        description: 'نقش پیش‌فرض شخص هنگام تشکیل پرونده؛ قابل حذف نیست',
        isSystem: true,
      },
      select: { id: true },
    });
  }
}

@Controller('auth')
export class LoginController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto);
  }

  @Public()
  @Post('register')
  register(@Body() dto: RegisterEconomicActorDto) {
    return this.auth.register(dto);
  }
}

@Controller('auth')
export class MeController {
  @Get('me')
  me(@CurrentUser() user: PortalUser) {
    return user;
  }
}

@Injectable()
export class AuthBoundaryMarker {}

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'portal-jwt' }),
    JwtModule.register({}),
  ],
  controllers: [LoginController, MeController],
  providers: [
    AuthService,
    PortalJwtStrategy,
    AuthBoundaryMarker,
    { provide: APP_GUARD, useClass: PortalAuthGuard },
  ],
  exports: [JwtModule],
})
export class AuthModule {}
