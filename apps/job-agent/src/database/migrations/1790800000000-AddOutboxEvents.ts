import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Transactional outbox for the events a new job implies.
 *
 * Written in the same transaction as the job row so `jobs.index` and `jobs.new`
 * cannot be lost after the consumer has acknowledged `jobs.raw`.
 */
export class AddOutboxEvents1790800000000 implements MigrationInterface {
  name = 'AddOutboxEvents1790800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "outbox_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "topic" character varying NOT NULL,
        "partitionKey" character varying NOT NULL,
        "payload" jsonb NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "lastError" text,
        "publishedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_outbox_events_id" PRIMARY KEY ("id")
      )
    `);

    // The relay's only query: unpublished rows, oldest first.
    await queryRunner.query(`
      CREATE INDEX "idx_outbox_pending" ON "outbox_events" ("publishedAt", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_outbox_pending"`);
    await queryRunner.query(`DROP TABLE "outbox_events"`);
  }
}
