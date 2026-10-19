import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccountModule } from './account/account.module';
import { AuthModule } from './auth/auth.module';
import { CasesModule } from './cases/cases.module';
import configuration from './config/configuration';
import { IssuanceModule } from './issuance/issuance.module';
import { LookupsModule } from './lookups/lookups.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      expandVariables: true,
      isGlobal: true,
      load: [configuration],
    }),
    PrismaModule,
    AuthModule,
    AccountModule,
    CasesModule,
    IssuanceModule,
    LookupsModule,
  ],
})
export class AppModule {}
