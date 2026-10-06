import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DEFAULT_PREFERENCES,
  MAX_DOCUMENT_BYTES,
  ResumeDataSchema,
  documentExtension,
  isAllowedDocumentMime,
  type JobPreferences,
  type ResumeData,
  type ResumeLink,
  type ResumeParseResult,
} from '@job-agent/shared';
import { UpdateProfileDto } from './profile.dto.js';
import { Profile } from './profile.entity.js';
import { RagClientService } from '../rag/rag-client.service.js';
import { ResumeParserService } from './resume-parser.service.js';

export type ResumeUpload = {
  fileName: string;
  mimeType: string;
  content: Buffer;
};

@Injectable()
export class ProfileService {
  private readonly log = new Logger(ProfileService.name);

  constructor(
    @InjectRepository(Profile) private readonly repo: Repository<Profile>,
    private readonly rag: RagClientService,
    private readonly parser: ResumeParserService,
  ) {}

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

  /**
   * Upload a resume: store the file, extract its text, parse it, prefill the
   * profile.
   *
   * One synchronous request, in this order, because each step is a precondition
   * for the one after it and the browser is waiting. The text is persisted before
   * the LLM is called, so a parsing failure costs the fields and not the resume.
   */
  async uploadResume(profileId: string, upload: ResumeUpload): Promise<ResumeParseResult> {
    this.validateResume(upload);
    if (!this.rag.enabled) {
      throw new ServiceUnavailableException(
        'Resume upload is not configured: RAG_INTERNAL_SECRET is missing on the API.',
      );
    }

    const stored = await this.rag.putResume(
      profileId,
      upload.fileName,
      upload.content,
      upload.mimeType,
    );
    if (!stored) {
      throw new ServiceUnavailableException(
        'The document service is unavailable, so the resume could not be read. Try again.',
      );
    }

    const { data, warning } = await this.parser.parse(stored.text);
    const profile = await this.getById(profileId);

    profile.resumeText = stored.text;
    profile.resumeFileName = upload.fileName;
    profile.resumeMimeType = upload.mimeType;
    profile.resumeSizeBytes = String(upload.content.length);
    profile.resumeObjectKey = stored.objectKey;
    profile.resumeData = data;
    profile.resumeParsedAt = data ? new Date() : null;
    profile.resumeError = warning;

    if (data) this.prefill(profile, data);

    await this.repo.save(profile);
    this.log.log(
      `Resume ${upload.fileName} stored for ${profileId} (${stored.text.length} chars, ` +
        `${stored.detected}${data ? `, ${data.experience.length} roles parsed` : ''})`,
    );

    return {
      profileId,
      fileName: upload.fileName,
      objectKey: stored.objectKey,
      detected: stored.detected,
      textChars: stored.text.length,
      parsed: data ?? EMPTY_RESUME,
      enriched: data !== null,
      warnings: warning ? [warning] : [],
    };
  }

  /**
   * A signed URL for the stored file, so the browser can open it directly.
   *
   * Signing happens in the document service, which owns the bucket: the job agent
   * has no AWS credentials and should not have any. Returns 404 when there is no
   * resume rather than a null link, because from here it is a user mistake, not an
   * optional subsystem being down.
   */
  async resumeLink(profileId: string): Promise<ResumeLink> {
    const profile = await this.getById(profileId);
    if (!profile.resumeObjectKey) throw new NotFoundException('No resume uploaded yet');
    if (!this.rag.enabled) {
      throw new ServiceUnavailableException('Resume viewing needs the document service');
    }

    const link = await this.rag.resumeLink(
      profileId,
      profile.resumeObjectKey,
      profile.resumeFileName ?? 'resume',
    );
    if (!link) {
      throw new ServiceUnavailableException('Could not sign a link to the stored resume');
    }
    return link;
  }

  /** Forget the resume. The object in the bucket is left alone: it is not addressable without the key. */
  async removeResume(profileId: string): Promise<Profile> {
    const profile = await this.getById(profileId);
    profile.resumeText = '';
    profile.resumeFileName = null;
    profile.resumeMimeType = null;
    profile.resumeSizeBytes = null;
    profile.resumeObjectKey = null;
    profile.resumeData = null;
    profile.resumeParsedAt = null;
    profile.resumeError = null;
    return this.repo.save(profile);
  }

  /**
   * Fill the fields the resume can answer for, without destroying what is there.
   *
   * Skills and locations are unioned rather than replaced: they are a set, and a
   * user who typed "Kubernetes" by hand does not expect an upload to drop it.
   * Roles are only seeded when empty, because roles are a statement of intent —
   * what the user wants next, which a resume of past jobs cannot know.
   */
  private prefill(profile: Profile, data: ResumeData): void {
    const prefs: JobPreferences = { ...DEFAULT_PREFERENCES, ...profile.preferences };

    if (!prefs.roles?.length && data.roles.length) prefs.roles = data.roles.slice(0, 5);
    if (!prefs.skills?.length && data.skills.length) prefs.skills = data.skills.slice(0, 20);
    else if (data.skills.length) {
      prefs.skills = union(prefs.skills, data.skills).slice(0, 40);
    }
    if (data.location) {
      prefs.locations = union(prefs.locations, [data.location]).slice(0, 10);
    }

    if (data.fullName && (!profile.name || profile.name === 'Me')) profile.name = data.fullName;

    profile.preferences = prefs;
  }

  private validateResume(upload: ResumeUpload): void {
    if (upload.content.length === 0) throw new BadRequestException('The file was empty');
    if (!isAllowedDocumentMime(upload.mimeType)) {
      throw new BadRequestException(
        `Unsupported file type. Allowed: PDF, DOCX, TXT, MD (got ${upload.mimeType}).`,
      );
    }
    if (!documentExtension(upload.fileName)) {
      throw new BadRequestException('The file name must end in .pdf, .docx, .txt or .md');
    }
    if (upload.content.length > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException(
        `That file is ${(upload.content.length / 1024 / 1024).toFixed(1)} MB; the limit is ${
          MAX_DOCUMENT_BYTES / 1024 / 1024
        } MB.`,
      );
    }
  }
}

/** Case-insensitive union that keeps the first spelling seen. */
function union(existing: string[] | undefined, incoming: string[]): string[] {
  const out = [...(existing ?? [])];
  const seen = new Set(out.map((v) => v.toLowerCase()));
  for (const value of incoming) {
    const key = value.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** What the caller gets when the parse failed: the shape, empty rather than absent. */
const EMPTY_RESUME: ResumeData = ResumeDataSchema.parse({});
