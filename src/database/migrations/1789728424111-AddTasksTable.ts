import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTasksTable1789728424111 implements MigrationInterface {
    name = 'AddTasksTable1789728424111'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tasks" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "isCompleted" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_8d12ff38fcc62aaba2cab748772" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "tasks"`);
    }

}
