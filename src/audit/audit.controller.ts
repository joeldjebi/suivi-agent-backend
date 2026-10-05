import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import { PaginationQuery } from '../common/pagination.dto';
import { DbService } from '../common/db.service';
import { RequiresFeature, Roles } from '../common/decorators';
import { AuditLog } from '../entities';

@ApiTags("Journal d'accès")
@ApiBearerAuth()
@Roles(Role.Admin)
@RequiresFeature(Feature.Audit)
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@Query() query: PaginationQuery) {
    const [items, total] = await this.db.manager.findAndCount(AuditLog, {
      order: { createdAt: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { items, total, page: query.page, limit: query.limit };
  }
}
