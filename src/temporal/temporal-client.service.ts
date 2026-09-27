import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Client, Connection, ScheduleAlreadyRunning, ScheduleOverlapPolicy,
} from '@temporalio/client';
import { SCHEDULE_ID, TASK_QUEUE, WORKFLOW_NAME } from '../common/constants.js';

/**
 * Thin wrapper around the Temporal gRPC client used by the HTTP API:
 *  - startRun      -> "search now" button, runs the daily workflow for one profile
 *  - ensureSchedule -> idempotently registers the daily cron schedule (called by the worker)
 *
 * The connection is created when the service is instantiated but the actual gRPC
 * calls only happen on demand, so the API works even while Temporal server is down.
 */
@Injectable()
export class TemporalClientService implements OnModuleDestroy {
  private readonly log = new Logger(TemporalClientService.name);
  private readonly client: Client;
  private scheduleEnsured = false;

  constructor(private readonly config: ConfigService) {
    this.client = new Client({
      // lazy -> no connection attempt until a workflow/schedule call is actually made
      connection: Connection.lazy({
        address: config.get<string>('TEMPORAL_ADDRESS', 'localhost:7233'),
      }),
      namespace: config.get<string>('TEMPORAL_NAMESPACE', 'default'),
    });
  }

  /** Stop one profile's full job-search pipeline immediately. */
  async startRun(profileId: string) {
    const run = await this.client.workflow.start(WORKFLOW_NAME, {
      taskQueue: TASK_QUEUE,
      workflowId: `manual-${profileId}-${Date.now()}`,
      args: [{ profileId }],
    });
    return { workflowId: run.workflowId, runId: run.firstExecutionRunId };
  }

  /**
   * Register the daily schedule once per namespace. Safe to call on every boot:
   * if the schedule already exists we treat it as success (idempotent).
   */
  async ensureSchedule() {
    if (this.scheduleEnsured) return;

    const cron = this.config.get<string>('SCHEDULE_CRON', '0 10 * * *');
    const timezone = this.config.get<string>('SCHEDULE_TIMEZONE', 'UTC');

    try {
      await this.client.schedule.create({
        scheduleId: SCHEDULE_ID,
        spec: { cronExpressions: [cron], timezone },
        policies: {
          overlap: ScheduleOverlapPolicy.SKIP,
          catchupWindow: '3 minutes',
          pauseOnFailure: false,
        },
        action: {
          type: 'startWorkflow',
          workflowType: WORKFLOW_NAME,
          taskQueue: TASK_QUEUE,
          workflowId: `${SCHEDULE_ID}-workflow`,
          args: [{}], // input.profileId omitted -> all active profiles
        },
      });
      this.scheduleEnsured = true;
      this.log.log(
        `Schedule "${SCHEDULE_ID}" created -> "${cron}" (${timezone}) on queue ${TASK_QUEUE}`,
      );
    } catch (e) {
      if (e instanceof ScheduleAlreadyRunning) {
        this.scheduleEnsured = true;
        this.log.log(`Schedule "${SCHEDULE_ID}" already exists`);
        return;
      }
      throw e;
    }
  }

  async onModuleDestroy() {
    await this.client.connection.close();
  }
}