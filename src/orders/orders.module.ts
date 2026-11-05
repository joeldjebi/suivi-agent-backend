import { Module } from '@nestjs/common';
import { OutletsModule } from '../outlets/outlets.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PaymentsService } from './payments.service';

@Module({
  imports: [OutletsModule],
  controllers: [OrdersController],
  providers: [OrdersService, PaymentsService],
  exports: [OrdersService, PaymentsService],
})
export class OrdersModule {}
