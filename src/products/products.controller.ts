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
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Feature, Role } from '@suivi/shared';
import { RequiresFeature, Roles } from '../common/decorators';
import {
  CreateProductDto,
  ListProductsQuery,
  UpdateProductDto,
} from './products.dto';
import { ProductsService } from './products.service';
import { RateLimit } from '../common/rate-limit';

/** Catalogue de produits : formules qui incluent les relevés produits ou la prise de commande. */
@ApiTags('Produits')
@ApiBearerAuth()
@RequiresFeature(Feature.ProductAudits, Feature.Orders)
@Roles(Role.Admin, Role.TeamLead, Role.Agent)
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Query() query: ListProductsQuery) {
    return this.products.list(query);
  }

  /** Modèle Excel d'import du catalogue. */
  @Roles(Role.Admin)
  @ApiProduces(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  @Get('import/template')
  async template(@Res({ passthrough: true }) res: Response) {
    const file = await this.products.template();
    res.set({
      'Content-Type': file.mime,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Cache-Control': 'no-store',
    });
    return new StreamableFile(file.data);
  }

  /** Import Excel (.xlsx) ou CSV : les lignes écartées sont renvoyées avec leur motif. */
  @Roles(Role.Admin)
  @RateLimit(10, 600)
  @Post('import')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  import(@UploadedFile() file: Express.Multer.File | undefined) {
    return this.products.import(file);
  }

  @Roles(Role.Admin)
  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @Roles(Role.Admin)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(id, dto);
  }

  @Roles(Role.Admin)
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.remove(id);
  }
}
