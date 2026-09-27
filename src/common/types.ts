export interface JobPreferences {
  roles: string[]; // e.g. ["Full Stack Developer", "React Native Developer"]
  skills: string[]; // e.g. ["React", "Node.js", "PostgreSQL"]
  locations: string[]; // e.g. ["Bengaluru", "Hyderabad"]
  remoteOnly: boolean;
  minSalary?: number;
  excludedKeywords: string[]; // matched against job title
  excludedCompanies: string[];
  greenhouseBoards: string[]; // company board tokens, e.g. ["stripe", "airbnb"]
  sources?: string[]; // restrict to these sources; default = all enabled
  postedWithinDays: number;
}

export const DEFAULT_PREFERENCES: JobPreferences = {
  roles: [],
  skills: [],
  locations: [],
  remoteOnly: false,
  excludedKeywords: [],
  excludedCompanies: [],
  greenhouseBoards: [],
  postedWithinDays: 7,
};

export interface RawJob {
  externalId: string;
  title: string;
  company: string;
  location?: string;
  remote?: boolean;
  salaryText?: string;
  description?: string;
  applyUrl: string;
  postedAt?: string; // ISO
}

export interface RawJobEvent {
  runId: string;
  profileId: string;
  source: string;
  job: RawJob;
}
export interface NewJobEvent {
  jobId: string;
  profileId: string;
}
export interface ScoredJobEvent {
  jobId: string;
  profileId: string;
  score: number;
}
export interface DlqEvent {
  stage: string;
  error: string;
  payload: unknown;
}
