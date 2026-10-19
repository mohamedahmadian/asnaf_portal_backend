import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHealth(): { service: string; status: 'ok' } {
    return {
      service: 'asnaf-portal-backend',
      status: 'ok',
    };
  }
}
