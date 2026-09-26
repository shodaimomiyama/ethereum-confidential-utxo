import type { ServiceExtension } from '../extensions.js';
import { rewardMigrations } from './schema.js';

export const rewardExtension: ServiceExtension = {
  migrations: rewardMigrations,
  routes: [],
};
