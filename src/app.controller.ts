import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AppService } from './app.service';
import { Public } from './common/decorators';

@ApiTags('Santé')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** 200 si tout répond, 503 si la base ou Redis est en panne (détail dans la réponse). */
  @Public()
  @Get('health')
  async health(@Res({ passthrough: true }) res: Response) {
    const sante = await this.appService.health();
    if (sante.status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return sante;
  }
}
