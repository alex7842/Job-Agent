import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stores the text extracted from each document.
 *
 * Search builds its query from this column: the job agent sends document ids
 * rather than the resume text, so the bytes are read and parsed once, at index
 * time, instead of being re-extracted on every search.
 */
export class AddRagDocumentExtractedText1790600000000 implements MigrationInterface {
  name = 'AddRagDocumentExtractedText1790600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "rag_documents" ADD "extractedText" text`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "rag_documents" DROP COLUMN "extractedText"`);
  }
}
