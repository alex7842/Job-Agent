import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProfileController } from './profile.controller.js';
import { Profile } from './profile.entity.js';
import { ProfileService } from './profile.service.js';
import { ResumeParserService } from './resume-parser.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Profile])],
  controllers: [ProfileController],
  providers: [ProfileService, ResumeParserService],
  // ResumeParserService is exported for the admin dashboard's model panel, so it
  // can report the parsing model alongside the scoring one.
  exports: [ProfileService, ResumeParserService],
})
export class ProfileModule {}
