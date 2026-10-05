import { Module } from '@nestjs/common';
import { PayrollCalculator } from './payroll.calculator';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';

@Module({
  controllers: [PayrollController],
  providers: [PayrollService, PayrollCalculator],
  exports: [PayrollService],
})
export class PayrollModule {}
