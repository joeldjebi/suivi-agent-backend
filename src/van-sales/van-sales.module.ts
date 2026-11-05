import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { OutletsModule } from '../outlets/outlets.module';
import { StockService } from './stock.service';
import { StockController, VanSalesController } from './van-sales.controller';
import { VanSalesService } from './van-sales.service';

@Module({
  imports: [OrdersModule, OutletsModule],
  controllers: [StockController, VanSalesController],
  providers: [StockService, VanSalesService],
  exports: [StockService],
})
export class VanSalesModule {}
