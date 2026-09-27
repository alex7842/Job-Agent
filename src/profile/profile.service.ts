import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DEFAULT_PREFERENCES } from '../common/types.js';
import { UpdateProfileDto } from './profile.dto.js';
import { Profile } from './profile.entity.js';

@Injectable()
export class ProfileService {
  constructor(@InjectRepository(Profile) private readonly repo: Repository<Profile>) {}

  /** Single-user for now: first profile, created on demand. */
  async getOrCreate(): Promise<Profile> {
    const existing = await this.repo.find({ order: { createdAt: 'ASC' }, take: 1 });
    if (existing[0]) return existing[0];
    return this.repo.save(this.repo.create({ preferences: { ...DEFAULT_PREFERENCES } }));
  }

  async getById(id: string): Promise<Profile> {
    const p = await this.repo.findOneBy({ id });
    if (!p) throw new NotFoundException(`Profile ${id} not found`);
    return p;
  }

  listActive(): Promise<Profile[]> {
    return this.repo.findBy({ isActive: true });
  }

  async update(dto: UpdateProfileDto): Promise<Profile> {
    const p = await this.getOrCreate();
    const { preferences, ...rest } = dto;
    Object.assign(p, rest);
    if (preferences) {
      const clean = Object.fromEntries(Object.entries(preferences).filter(([, v]) => v !== undefined));
      p.preferences = { ...p.preferences, ...clean };
    }
    return this.repo.save(p);
  }
}
