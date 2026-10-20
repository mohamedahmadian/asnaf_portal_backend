import { Controller, Get, Module, Param, Query } from '@nestjs/common';
import { CurrentUser, PortalUser } from '../auth/auth.module';
import { MySmsListQuery } from './dto/my-sms-list.query';
import { SmsService } from './sms.service';

@Controller('account/sms')
export class MySmsController {
  constructor(private readonly sms: SmsService) {}

  @Get()
  list(@CurrentUser() user: PortalUser, @Query() query: MySmsListQuery) {
    return this.sms.listMine(user.id, query);
  }

  @Get(':id')
  findOne(@CurrentUser() user: PortalUser, @Param('id') id: string) {
    return this.sms.findMine(user.id, id);
  }
}

@Module({
  controllers: [MySmsController],
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}
