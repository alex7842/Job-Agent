import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the document catalog now that a resume lives on the profile row.
 *
 * Both tables go: `documents` was the job agent's catalog of uploaded files and
 * `rag_documents` the RAG service's copy of the same thing, and after the
 * refactor nothing reads either one. The vectors already indexed from those
 * files are not touched here — they are Pinecone records keyed by vector kind,
 * and they are no longer reachable because no query asks for a document kind.
 *
 * The semantic columns on `jobs` stay: they hold the per-posting scores the
 * retriever still returns, they just no longer point at a catalog row.
 */
export class RemoveDocumentCatalog1791000000000 implements MigrationInterface {
  name = 'RemoveDocumentCatalog1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Indexes and the partial unique index go with their table.
    await queryRunner.query(`DROP TABLE IF EXISTS "documents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_documents"`);

    // Postgres will not drop a type that is still referenced, and no column
    // references these any more, so this only fails if something above did not.
    await queryRunner.query(`DROP TYPE IF EXISTS "document_kind"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "document_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "rag_document_kind"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "rag_document_status"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "document_kind" AS ENUM ('resume', 'cover_letter', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "document_status" AS ENUM ('awaiting_upload', 'indexing', 'ready', 'failed', 'deleted')`,
    );
    await queryRunner.query(`
      CREATE TABLE "documents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "profileId" uuid NOT NULL,
        "kind" "document_kind" NOT NULL,
        "fileName" character varying NOT NULL,
        "mimeType" character varying NOT NULL,
        "sizeBytes" bigint NOT NULL,
        "objectKey" character varying NOT NULL,
        "status" "document_status" NOT NULL DEFAULT 'awaiting_upload',
        "isPrimary" boolean NOT NULL DEFAULT false,
        "chunkCount" integer NOT NULL DEFAULT 0,
        "errorMessage" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_documents_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_documents_profile_created" ON "documents" ("profileId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_documents_primary" ON "documents" ("profileId") WHERE "isPrimary" = true`,
    );

    await queryRunner.query(
      `CREATE TYPE "rag_document_kind" AS ENUM ('resume', 'cover_letter', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "rag_document_status" AS ENUM ('uploaded', 'indexing', 'ready', 'failed', 'deleted')`,
    );
    await queryRunner.query(`
      CREATE TABLE "rag_documents" (
        "documentId" uuid NOT NULL,
        "profileId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "kind" "rag_document_kind" NOT NULL,
        "fileName" character varying NOT NULL,
        "mimeType" character varying NOT NULL,
        "sizeBytes" bigint NOT NULL,
        "objectKey" character varying NOT NULL,
        "status" "rag_document_status" NOT NULL DEFAULT 'uploaded',
        "isPrimary" boolean NOT NULL DEFAULT false,
        "chunkCount" integer NOT NULL DEFAULT 0,
        "errorMessage" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "extractedText" text,
        CONSTRAINT "PK_rag_documents_documentId" PRIMARY KEY ("documentId")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_rag_documents_profile_created" ON "rag_documents" ("profileId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_rag_documents_primary" ON "rag_documents" ("profileId") WHERE "isPrimary" = true AND "status" = 'ready'`,
    );
  }
}
