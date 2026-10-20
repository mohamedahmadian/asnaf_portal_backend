import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type SendSmsInput = {
  phone: string;
  body: string;
};

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async send(input: SendSmsInput) {
    const settings = await this.prisma.smsSettings.findUnique({
      where: { singletonKey: 'default' },
    });
    if (!settings?.isActive || !settings.endpoint) {
      this.logger.warn(`SMS mock. Would send to ${input.phone} (${input.body.length} chars)`);
      return { mocked: true, skipped: true };
    }
    try {
      const response = await fetch(settings.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: settings.username ?? '',
          password: settings.password ?? '',
          from: settings.senderNumber ?? '',
          to: input.phone,
          text: input.body,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        this.logger.warn(`SMS send failed ${response.status} for ${input.phone}`);
        return { mocked: false, skipped: true };
      }
      return { mocked: false, skipped: false };
    } catch (error) {
      this.logger.warn(`SMS send error for ${input.phone}: ${String(error)}`);
      return { mocked: false, skipped: true };
    }
  }
}
