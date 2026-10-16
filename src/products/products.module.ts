import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { SuggestionsController } from './suggestions.controller';
import { SuggestionsService } from './suggestions.service';

@Module({
  controllers: [ProductsController, SuggestionsController],
  providers: [ProductsService, SuggestionsService],
  exports: [ProductsService],
})
export class ProductsModule {}
