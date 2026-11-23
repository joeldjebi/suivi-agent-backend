import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { PlatformRoute } from '../platform/platform-auth';
import {
  ListProspectsDto,
  SaveProspectDto,
  UpdateProspectDto,
  UpdateTemplateDto,
} from './prospects.dto';
import { ProspectsService } from './prospects.service';

const hidden = process.env.NODE_ENV === 'production';

/** Console éditeur : prospection commerciale (démarchage sortant). */
@ApiTags('Plateforme — prospection')
@ApiExcludeController(hidden)
@PlatformRoute()
@Controller('platform/prospects')
export class ProspectsController {
  constructor(private readonly prospects: ProspectsService) {}

  @Get()
  list(@Query() query: ListProspectsDto) {
    return this.prospects.list(query);
  }

  @Get('templates')
  templates() {
    return this.prospects.templates();
  }

  @Patch('templates/:id')
  updateTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.prospects.updateTemplate(id, dto);
  }

  @Post()
  create(@Body() dto: SaveProspectDto) {
    return this.prospects.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProspectDto,
  ) {
    return this.prospects.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.prospects.remove(id);
  }
}
