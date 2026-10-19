import {
  Body,
  Controller,
  createParamDecorator,
  ExecutionContext,
  Get,
  Injectable,
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
import { IsString, MinLength } from 'class-validator';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

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

export class LoginDto {
  @IsString()
  @MinLength(1)
  identifier: string;

  @IsString()
  @MinLength(1)
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

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto) {
    const identifier = dto.identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        status: 'ACTIVE',
        OR: [
          { username: identifier },
          { nationalId: identifier },
          { phone: identifier },
        ],
        userRoles: { some: { role: { code: ECONOMIC_ACTOR_ROLE } } },
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
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('نام کاربری یا رمز عبور نادرست است');
    }
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
}

@Controller('auth')
export class LoginController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
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
