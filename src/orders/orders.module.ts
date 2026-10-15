import { Module } from '@nestjs/common';
import { OutletsModule } from '../outlets/outlets.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [OutletsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
