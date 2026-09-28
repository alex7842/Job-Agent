import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DEFAULT_PREFERENCES } from '@job-agent/shared';
import { UpdateProfileDto } from './profile.dto.js';
import { Profile } from './profile.entity.js';

@Injectable()
export class ProfileService {
  constructor(@InjectRepository(Profile) private readonly repo: Repository<Profile>) {}

  /**
   * The caller's profile, created on first use. Every jobs/runs query keys off
   * this id, so this is the isolation boundary — no global "first profile".
   */
  async forUser(userId: string): Promise<Profile> {
    const existing = await this.repo.findOneBy({ userId });
    if (existing) return existing;
    return this.repo.save(this.repo.create({ userId, preferences: { ...DEFAULT_PREFERENCES } }));
  }

  async getById(id: string): Promise<Profile> {
    const p = await this.repo.findOneBy({ id });
    if (!p) throw new NotFoundException(`Profile ${id} not found`);
    return p;
  }

  listActive(): Promise<Profile[]> {
    return this.repo.findBy({ isActive: true });
  }

  /** Merges preferences rather than replacing them, so partial updates are additive. */
  async update(profileId: string, dto: UpdateProfileDto): Promise<Profile> {
    const p = await this.getById(profileId);
    const { preferences, ...rest } = dto;
    Object.assign(p, rest);
    if (preferences) {
      const clean = Object.fromEntries(
        Object.entries(preferences).filter(([, v]) => v !== undefined),
      );
      p.preferences = { ...p.preferences, ...clean };
    }
    return this.repo.save(p);
  }
}
