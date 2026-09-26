import type { ServiceExtension } from '../extensions.js';
import { rewardMigrations } from './schema.js';
import { rewardRoutes } from './routes.js';
import { runRewardAlarm } from './queue.js';

export const rewardExtension: ServiceExtension = {
  migrations: rewardMigrations,
  routes: rewardRoutes,
  alarm: runRewardAlarm,
};
