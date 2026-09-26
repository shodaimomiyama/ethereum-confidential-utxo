import type { ServiceExtension } from '../extensions.js';
import { rewardMigrations } from './schema.js';
import { rewardRoutes } from './routes.js';

export const rewardExtension: ServiceExtension = {
  migrations: rewardMigrations,
  routes: rewardRoutes,
};
