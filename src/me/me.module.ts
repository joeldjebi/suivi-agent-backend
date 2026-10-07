import { Module } from '@nestjs/common';
import { ZonesModule } from '../zones/zones.module';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  imports: [ZonesModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
