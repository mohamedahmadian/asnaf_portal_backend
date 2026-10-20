import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CaseRequestType, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const SETTINGS_ID = 'default';
const PLACES_NAME = 'اداره اماکن';

const DEFAULT_INQUIRY_LETTER_BODY = [
  'با سلام',
  'خواهشمند است نسبت به استعلام {{fullName}} به شماره ملی {{nationalId}} با کد پیگیری {{trackingCode}} برای شغل {{jobTitle}} ({{unitTitle}}) اعلام نظر فرمایید.',
  'نشانی: {{address}}',
  'تلفن: {{phone}}',
].join('\n');

const DEFAULT_PLACES_LETTER_BODY = [
  'با سلام',
  'خواهشمند است نسبت به {{fullName}} به شماره ملی {{nationalId}} با کد پیگیری {{trackingCode}} برای شغل {{jobTitle}} ({{unitTitle}}) اعلام نظر فرمایید.',
  'نشانی: {{address}}',
  'تلفن: {{phone}}',
].join('\n');

type LetterTarget = 'inquiry' | 'places';
type PaperSize = 'A4' | 'A5';

function paperSize(value: string | null | undefined): PaperSize {
  return value === 'A5' ? 'A5' : 'A4';
}

function jalaliYear(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (month < 3 || (month === 3 && day < 21)) return year - 622;
  return year - 621;
}

function localIsoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dataUrl(image: { mimeType: string; data: Uint8Array } | null | undefined) {
  if (!image) return null;
  const mime = image.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${Buffer.from(image.data).toString('base64')}`;
}

@Injectable()
export class PortalLettersService {
  constructor(private readonly prisma: PrismaService) {}

  async inquiryLetter(
    userId: string,
    caseId: string,
    inquiryId: string,
    requestType?: CaseRequestType,
    requestId?: string,
  ) {
    const row = await this.prisma.caseInquiry.findFirst({
      where: {
        id: inquiryId,
        caseFileId: caseId,
        caseFile: { userId },
        ...(requestId ? { caseRequestId: requestId } : {}),
        ...(requestType ? { caseRequest: { type: requestType } } : {}),
      },
      include: {
        inquiryCenter: { select: { name: true, phone: true, letterTitle: true, letterBody: true } },
      },
    });
    if (!row) throw new NotFoundException('نامه یافت نشد');
    const person = await this.letterSubject(caseId, userId);
    if (!person) throw new NotFoundException('شخص یافت نشد');
    const issued = await this.openLetter('inquiry', row.id);
    const fields = {
      fullName: person.fullName,
      nationalId: person.nationalId ?? '',
      identityCertificateNo: person.identityCertificateNo ?? '',
      trackingCode: person.trackingCode ?? '',
      jobTitle: person.jobTitle ?? '',
      jobGroup: person.jobGroup ?? '',
      unitTitle: person.unitTitle ?? '',
      address: person.address ?? '',
      phone: person.phone ?? '',
      date: issued.issuedAt,
      letterNo: issued.letterNo,
      centerName: row.inquiryCenter.name,
    };
    const defaults = await this.defaults();
    return {
      id: row.id,
      centerName: row.inquiryCenter.name,
      centerPhone: row.inquiryCenter.phone,
      nationalId: person.nationalId,
      letterNo: issued.letterNo,
      issuedAt: issued.issuedAt,
      letterhead: issued.letterhead,
      letterTitle: row.inquiryCenter.letterTitle?.trim() || `استعلام ${fields.centerName}`,
      letterBody: row.inquiryCenter.letterBody?.trim() || defaults.defaultLetterBody,
      fields,
    };
  }

  async placesLetter(
    userId: string,
    caseId: string,
    requestType?: CaseRequestType,
    requestId?: string,
  ) {
    const row = await this.prisma.casePlacesReview.findFirst({
      where: {
        caseFileId: caseId,
        caseFile: { userId },
        ...(requestId ? { caseRequestId: requestId } : {}),
        ...(requestType ? { caseRequest: { type: requestType } } : {}),
      },
      orderBy: { caseRequest: { createdAt: 'desc' } },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('نامه یافت نشد');
    const person = await this.letterSubject(caseId, userId);
    if (!person) throw new NotFoundException('شخص یافت نشد');
    const office = await this.prisma.casePlacesOffice.findUnique({
      where: { id: SETTINGS_ID },
      select: { phone: true, letterTitle: true, letterBody: true },
    });
    const issued = await this.openLetter('places', row.id);
    const fields = {
      fullName: person.fullName,
      nationalId: person.nationalId ?? '',
      trackingCode: person.trackingCode ?? '',
      jobTitle: person.jobTitle ?? '',
      unitTitle: person.unitTitle ?? '',
      address: person.address ?? '',
      phone: person.phone ?? '',
      date: issued.issuedAt,
      letterNo: issued.letterNo,
      centerName: PLACES_NAME,
    };
    return {
      id: row.id,
      centerName: PLACES_NAME,
      centerPhone: office?.phone ?? null,
      nationalId: person.nationalId,
      letterNo: issued.letterNo,
      issuedAt: issued.issuedAt,
      letterhead: issued.letterhead,
      letterTitle: office?.letterTitle?.trim() || `اعلام نظر ${PLACES_NAME}`,
      letterBody: office?.letterBody?.trim() || DEFAULT_PLACES_LETTER_BODY,
      fields,
    };
  }

  private async letterSubject(caseId: string, userId: string) {
    const row = await this.prisma.caseFile.findFirst({
      where: { id: caseId, userId },
      select: {
        trackingCode: true,
        businessUnitTitle: true,
        premiseAddress: true,
        activityJob: { select: { title: true, group: { select: { title: true } } } },
        user: {
          select: {
            fullName: true,
            nationalId: true,
            identityCertificateNo: true,
            phone: true,
          },
        },
      },
    });
    if (!row) return null;
    return {
      fullName: row.user.fullName,
      nationalId: row.user.nationalId,
      identityCertificateNo: row.user.identityCertificateNo,
      phone: row.user.phone,
      trackingCode: row.trackingCode,
      unitTitle: row.businessUnitTitle,
      address: row.premiseAddress,
      jobTitle: row.activityJob?.title ?? null,
      jobGroup: row.activityJob?.group?.title ?? null,
    };
  }

  private async defaults() {
    const row = await this.prisma.caseLetterhead.findUnique({
      where: { id: SETTINGS_ID },
      select: { defaultLetterBody: true, defaultPaper: true },
    });
    return {
      defaultLetterBody: row?.defaultLetterBody?.trim() || DEFAULT_INQUIRY_LETTER_BODY,
      defaultPaper: paperSize(row?.defaultPaper),
    };
  }

  private async openLetter(target: LetterTarget, id: string) {
    const issued = await this.issue(target, id);
    return {
      letterNo: issued.letterNo,
      issuedAt: localIsoDate(issued.issuedAt),
      letterhead: await this.forLetter(),
    };
  }

  private async forLetter() {
    const row = await this.prisma.caseLetterhead.findUnique({
      where: { id: SETTINGS_ID },
      include: { logo: true, signature: true },
    });
    if (!row) {
      return {
        organizationName: null,
        address: null,
        phone: null,
        website: null,
        signerName: null,
        signerTitle: null,
        logoDataUrl: null,
        signatureDataUrl: null,
        defaultPaper: 'A4' as const,
      };
    }
    return {
      organizationName: row.organizationName,
      address: row.address,
      phone: row.phone,
      website: row.website,
      signerName: row.signerName,
      signerTitle: row.signerTitle,
      logoDataUrl: dataUrl(row.logo),
      signatureDataUrl: dataUrl(row.signature),
      defaultPaper: paperSize(row.defaultPaper),
    };
  }

  private async issue(target: LetterTarget, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const current =
        target === 'inquiry'
          ? await tx.caseInquiry.findUnique({
              where: { id },
              select: { letterNo: true, issuedAt: true },
            })
          : await tx.casePlacesReview.findUnique({
              where: { id },
              select: { letterNo: true, issuedAt: true },
            });
      if (!current) throw new NotFoundException('نامه یافت نشد');
      if (current.letterNo && current.issuedAt) {
        return { letterNo: current.letterNo, issuedAt: current.issuedAt };
      }
      if (current.letterNo) {
        const issuedAt = new Date();
        await this.writeIssue(tx, target, id, { issuedAt });
        return { letterNo: current.letterNo, issuedAt };
      }
      await tx.caseLetterhead.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID },
        update: {},
      });
      await tx.$queryRaw`SELECT id FROM case_letterheads WHERE id = ${SETTINGS_ID} FOR UPDATE`;
      const issuedAt = new Date();
      const year = jalaliYear(issuedAt);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const bumped = await tx.caseLetterhead.update({
          where: { id: SETTINGS_ID },
          data: { nextNumber: { increment: 1 } },
          select: { nextNumber: true },
        });
        const letterNo = `${year}/${String(bumped.nextNumber - 1).padStart(6, '0')}`;
        if (await this.letterNoTaken(tx, letterNo)) continue;
        try {
          await this.writeIssue(tx, target, id, { letterNo, issuedAt });
          return { letterNo, issuedAt };
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            continue;
          }
          throw error;
        }
      }
      throw new BadRequestException('شماره نامه صادر نشد');
    });
  }

  private async letterNoTaken(tx: Prisma.TransactionClient, letterNo: string) {
    const [inquiry, places, revocation] = await Promise.all([
      tx.caseInquiry.findFirst({ where: { letterNo }, select: { id: true } }),
      tx.casePlacesReview.findFirst({ where: { letterNo }, select: { id: true } }),
      tx.caseRevocationLetter.findFirst({ where: { letterNo }, select: { id: true } }),
    ]);
    return Boolean(inquiry || places || revocation);
  }

  private writeIssue(
    tx: Prisma.TransactionClient,
    target: LetterTarget,
    id: string,
    data: { letterNo?: string; issuedAt: Date },
  ) {
    if (target === 'inquiry') {
      return tx.caseInquiry.update({ where: { id }, data });
    }
    return tx.casePlacesReview.update({ where: { id }, data });
  }
}
