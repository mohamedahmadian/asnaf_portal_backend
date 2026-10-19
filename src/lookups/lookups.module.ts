import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LookupsService {
  constructor(private readonly prisma: PrismaService) {}

  countries() {
    return this.prisma.country.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
      select: { id: true, iso2: true, nameFa: true },
    });
  }

  cities(provinceId?: string) {
    return this.prisma.city.findMany({
      where: { isActive: true, ...(provinceId ? { provinceId } : {}) },
      orderBy: [{ province: { sortOrder: 'asc' } }, { nameFa: 'asc' }],
      select: {
        id: true,
        nameFa: true,
        provinceId: true,
        province: { select: { nameFa: true } },
      },
    });
  }

  jobGroups() {
    return this.prisma.jobGroup.findMany({
      where: { isActive: true },
      orderBy: { title: 'asc' },
      select: { id: true, title: true, code: true },
    });
  }

  jobs(groupId?: string) {
    return this.prisma.job.findMany({
      where: { isActive: true, ...(groupId ? { groupId } : {}) },
      orderBy: { title: 'asc' },
      select: {
        id: true,
        groupId: true,
        title: true,
        code: true,
        jobType: { select: { id: true, title: true } },
      },
    });
  }

  complexes() {
    return this.prisma.commercialComplex.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, address: true },
    });
  }

  registrationPlaces() {
    return this.prisma.registrationPlace.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { title: 'asc' }],
      select: { id: true, title: true, isDefault: true },
    });
  }

  documents() {
    return this.prisma.document.findMany({
      orderBy: { title: 'asc' },
      select: { id: true, code: true, title: true },
    });
  }
}

@Controller('lookups')
export class LookupsController {
  constructor(private readonly lookups: LookupsService) {}

  @Get('countries')
  countries() {
    return this.lookups.countries();
  }

  @Get('cities')
  cities(@Query('provinceId') provinceId?: string) {
    return this.lookups.cities(provinceId);
  }

  @Get('job-groups')
  jobGroups() {
    return this.lookups.jobGroups();
  }

  @Get('jobs')
  jobs(@Query('groupId') groupId?: string) {
    return this.lookups.jobs(groupId);
  }

  @Get('commercial-complexes')
  complexes() {
    return this.lookups.complexes();
  }

  @Get('registration-places')
  registrationPlaces() {
    return this.lookups.registrationPlaces();
  }

  @Get('documents')
  documents() {
    return this.lookups.documents();
  }
}

@Module({
  controllers: [LookupsController],
  providers: [LookupsService],
})
export class LookupsModule {}
