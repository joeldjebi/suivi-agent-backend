import { Module } from '@nestjs/common';
import { PhotosModule } from '../photos/photos.module';
import { ProductsModule } from '../products/products.module';
import { VisitsService } from './visits.service';
import { OutletsController } from './outlets.controller';
import { OutletsService } from './outlets.service';

@Module({
  imports: [PhotosModule, ProductsModule],
  controllers: [OutletsController],
  providers: [OutletsService, VisitsService],
  exports: [OutletsService, VisitsService],
})
export class OutletsModule {}
