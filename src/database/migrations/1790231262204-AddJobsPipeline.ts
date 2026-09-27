import { MigrationInterface, QueryRunner } from "typeorm";

export class AddJobsPipeline1790231262204 implements MigrationInterface {
    name = 'AddJobsPipeline1790231262204'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "profiles" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL DEFAULT 'Me', "resumeText" text NOT NULL DEFAULT '', "preferences" jsonb NOT NULL, "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8e520eb4da7dc01d0e190447c8e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "jobs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "profileId" uuid NOT NULL, "runId" uuid, "source" character varying NOT NULL, "externalId" character varying NOT NULL, "dedupeHash" character varying(40) NOT NULL, "title" character varying NOT NULL, "company" character varying NOT NULL, "location" character varying, "remote" boolean, "salaryText" character varying, "description" text, "applyUrl" text NOT NULL, "postedAt" TIMESTAMP WITH TIME ZONE, "matchScore" integer, "matchReason" text, "highlights" jsonb NOT NULL DEFAULT '[]', "redFlags" jsonb NOT NULL DEFAULT '[]', "scoredAt" TIMESTAMP WITH TIME ZONE, "scoreError" text, "status" "public"."jobs_status_enum" NOT NULL DEFAULT 'new', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "uq_jobs_profile_dedupe" UNIQUE ("profileId", "dedupeHash"), CONSTRAINT "PK_cf0a6c42b72fcc7f7c237def345" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_jobs_profile_status_score" ON "jobs"  ("profileId", "status", "matchScore") `);
        await queryRunner.query(`CREATE TABLE "search_runs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "profileId" uuid NOT NULL, "workflowId" character varying NOT NULL, "status" "public"."search_runs_status_enum" NOT NULL DEFAULT 'running', "stats" jsonb NOT NULL DEFAULT '{}', "startedAt" TIMESTAMP NOT NULL DEFAULT now(), "finishedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_223c23b7f967f8262616e95efcc" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "search_runs"`);
        await queryRunner.query(`DROP INDEX "public"."idx_jobs_profile_status_score"`);
        await queryRunner.query(`DROP TABLE "jobs"`);
        await queryRunner.query(`DROP TABLE "profiles"`);
    }

}
