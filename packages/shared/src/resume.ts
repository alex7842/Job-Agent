import { z } from 'zod';

/**
 * A resume, as extracted from an uploaded file.
 *
 * One row per profile. Every field has a default and is required in the JSON
 * schema below, because the provider decodes against that schema: an optional
 * property is one the model may silently omit, and a missing key here would be a
 * null the profile form then has to special-case. Absent data is an empty string
 * or an empty array, which the UI already knows how to render.
 */

export const ResumeExperienceSchema = z.object({
  company: z.string().max(200).default(''),
  title: z.string().max(200).default(''),
  location: z.string().max(200).default(''),
  /** Free text as written on the resume ("Mar 2021"), never normalised to a date. */
  startDate: z.string().max(40).default(''),
  endDate: z.string().max(40).default(''),
  current: z.boolean().default(false),
  summary: z.string().max(2000).default(''),
  highlights: z.array(z.string().max(400)).max(6).default([]),
});

export const ResumeEducationSchema = z.object({
  institution: z.string().max(200).default(''),
  degree: z.string().max(200).default(''),
  field: z.string().max(200).default(''),
  startYear: z.string().max(20).default(''),
  endYear: z.string().max(20).default(''),
});

export const ResumeDataSchema = z.object({
  fullName: z.string().max(200).default(''),
  email: z.string().max(320).default(''),
  phone: z.string().max(60).default(''),
  location: z.string().max(200).default(''),
  headline: z.string().max(300).default(''),
  summary: z.string().max(3000).default(''),
  links: z.array(z.string().max(300)).max(10).default([]),
  skills: z.array(z.string().max(80)).max(60).default([]),
  /** Titles the candidate has held, newest first. */
  roles: z.array(z.string().max(200)).max(15).default([]),
  /** Summed from the experience entries, or null when the dates are unusable. */
  yearsOfExperience: z.number().min(0).max(60).nullable().default(null),
  experience: z.array(ResumeExperienceSchema).max(15).default([]),
  education: z.array(ResumeEducationSchema).max(10).default([]),
  certifications: z.array(z.string().max(200)).max(15).default([]),
  languages: z.array(z.string().max(80)).max(15).default([]),
});

export type ResumeExperience = z.infer<typeof ResumeExperienceSchema>;
export type ResumeEducation = z.infer<typeof ResumeEducationSchema>;
export type ResumeData = z.infer<typeof ResumeDataSchema>;

/**
 * The hand-written JSON Schema handed to the provider as a decoding constraint.
 *
 * Duplicated from the zod schema on purpose, and every property is both required
 * and defaulted: a constrained decoder has no notion of "apply the default", so
 * a property it may omit is a property that arrives missing. `additionalProperties`
 * is false so the model cannot invent fields the profile does not store.
 */
export const RESUME_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    fullName: { type: 'string', maxLength: 200 },
    email: { type: 'string', maxLength: 320 },
    phone: { type: 'string', maxLength: 60 },
    location: { type: 'string', maxLength: 200 },
    headline: { type: 'string', maxLength: 300 },
    summary: { type: 'string', maxLength: 3000 },
    links: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 10 },
    skills: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 60 },
    roles: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 15 },
    yearsOfExperience: {
      type: ['integer', 'null'],
      minimum: 0,
      maximum: 60,
      description: 'Total years across all roles, or null when the dates are unreadable',
    },
    experience: {
      type: 'array',
      maxItems: 15,
      items: {
        type: 'object',
        properties: {
          company: { type: 'string', maxLength: 200 },
          title: { type: 'string', maxLength: 200 },
          location: { type: 'string', maxLength: 200 },
          startDate: { type: 'string', maxLength: 40 },
          endDate: { type: 'string', maxLength: 40 },
          current: { type: 'boolean' },
          summary: { type: 'string', maxLength: 2000 },
          highlights: {
            type: 'array',
            items: { type: 'string', maxLength: 400 },
            maxItems: 6,
          },
        },
        required: [
          'company',
          'title',
          'location',
          'startDate',
          'endDate',
          'current',
          'summary',
          'highlights',
        ],
        additionalProperties: false,
      },
    },
    education: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          institution: { type: 'string', maxLength: 200 },
          degree: { type: 'string', maxLength: 200 },
          field: { type: 'string', maxLength: 200 },
          startYear: { type: 'string', maxLength: 20 },
          endYear: { type: 'string', maxLength: 20 },
        },
        required: ['institution', 'degree', 'field', 'startYear', 'endYear'],
        additionalProperties: false,
      },
    },
    certifications: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 15 },
    languages: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 15 },
  },
  required: [
    'fullName',
    'email',
    'phone',
    'location',
    'headline',
    'summary',
    'links',
    'skills',
    'roles',
    'yearsOfExperience',
    'experience',
    'education',
    'certifications',
    'languages',
  ],
  additionalProperties: false,
} as const;

/** What the API returns after a resume has been parsed and applied. */
export type ResumeParseResult = {
  profileId: string;
  fileName: string;
  objectKey: string;
  detected: string;
  textChars: number;
  parsed: ResumeData;
  /** False when the profile had to be written without the LLM step. */
  enriched: boolean;
  warnings: string[];
};

/**
 * A short-lived URL for the stored resume.
 *
 * Returned rather than a redirect so the web app can show what it got: `store` is
 * `local` in dev, where the bytes are a file on disk and there is no URL to open.
 */
export const ResumeLinkSchema = z.object({
  url: z.string(),
  expiresInSeconds: z.number().int().positive(),
  store: z.string(),
});
export type ResumeLink = z.infer<typeof ResumeLinkSchema>;
