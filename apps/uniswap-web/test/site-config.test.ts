import { expect, it } from 'vitest';
import { readSiteConfig } from '../src/site/config.js';

it('omits unpublished evidence and keeps a configured code link', () => {
  const empty = readSiteConfig({
    VITE_DIM_MODE: 'mock',
    VITE_DIM_CODE_URL: '',
    VITE_DIM_EVIDENCE_URL: '',
  });
  expect(empty.mode).toBe('mock');
  expect(empty.evidenceUrl).toBeUndefined();

  const configured = readSiteConfig({
    VITE_DIM_MODE: 'mock',
    VITE_DIM_CODE_URL: 'https://github.com/shodaimomiyama/ethereum-confidential-utxo',
  });
  expect(configured.codeUrl).toContain('github.com');
});

it('rejects a non-HTTPS evidence URL', () => {
  expect(() => readSiteConfig({
    VITE_DIM_MODE: 'mock',
    VITE_DIM_EVIDENCE_URL: 'http://example.com/unverified',
  })).toThrow('VITE_DIM_EVIDENCE_URL');
});
