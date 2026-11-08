import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { OutletsModule } from '../outlets/outlets.module';
import { PositionsModule } from '../positions/positions.module';
import { StockService } from './stock.service';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';
import { StockController, VanSalesController } from './van-sales.controller';
import { VanSalesService } from './van-sales.service';

@Module({
  imports: [OrdersModule, OutletsModule, PositionsModule],
  controllers: [StockController, VanSalesController, TransfersController],
  providers: [StockService, VanSalesService, TransfersService],
  exports: [StockService, TransfersService],
})
export class VanSalesModule {}
