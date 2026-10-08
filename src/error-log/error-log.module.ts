import { Global, Module } from '@nestjs/common';
import { ClientErrorsController } from './client-errors.controller';
import { ErrorLogService } from './error-log.service';

@Global()
@Module({
  controllers: [ClientErrorsController],
  providers: [ErrorLogService],
  exports: [ErrorLogService],
})
export class ErrorLogModule {}
