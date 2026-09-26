import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { keccak256 } from 'viem';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPairAddressConsistency,
  loadUniswapArtifacts,
  validateUniswapProvenance,
} from '../../scripts/uniswap-artifact.mjs';
import { verifyUniswapSources } from '../../scripts/uniswap-source.mjs';

const pair = { bytecode: '0x60006000' };
const factory = { pairInitCodeHash: keccak256(pair.bytecode) };
const router02 = { pairInitCodeHash: keccak256(pair.bytecode) };

test('the Router and Factory reject a Pair compiled with another init code hash', () => {
  assert.doesNotThrow(() => assertPairAddressConsistency(factory, pair, router02));
  assert.throws(
    () => assertPairAddressConsistency(factory, pair, { pairInitCodeHash: `0x${'00'.repeat(32)}` }),
    /init code hash/i,
  );
  assert.throws(
    () => assertPairAddressConsistency({ pairInitCodeHash: `0x${'00'.repeat(32)}` }, pair, router02),
    /init code hash/i,
  );
});

test('artifact provenance requires source commits, compilers and the local patch', () => {
  const record = {
    commits: { core: 'a'.repeat(40), periphery: 'b'.repeat(40), lib: 'c'.repeat(40) },
    compilers: { core: '0.5.16', periphery: '0.6.6' },
    localPatch: { file: 'periphery/contracts/libraries/UniswapV2Library.sol', before: '0x1', after: '0x2' },
  };
  assert.doesNotThrow(() => validateUniswapProvenance(record));
  for (const missing of ['commits', 'compilers', 'localPatch']) {
    const changed = structuredClone(record);
    delete changed[missing];
    assert.throws(() => validateUniswapProvenance(changed), /provenance/i);
  }
});

test('fixed v2 build exposes real Factory, Pair, Router02 and WETH9 artifacts', () => {
  const artifacts = loadUniswapArtifacts();
  assertPairAddressConsistency(artifacts.factory, artifacts.pair, artifacts.router02);
  assert.equal(keccak256(artifacts.pair.bytecode.object),
    '0x730b60d8659dba7089b26ec3c5b93e948a9e179fd7a2db2d3c15732d610c2061');
  assert.match(artifacts.factory.metadata.compiler.version, /^0\.5\.16\+/);
  assert.match(artifacts.router02.metadata.compiler.version, /^0\.6\.6\+/);
  assert.match(artifacts.weth9.metadata.compiler.version, /^0\.6\.6\+/);
  assert.ok(artifacts.factory.abi.some(item => item.name === 'createPair'));
  assert.ok(artifacts.router02.abi.some(item => item.name === 'addLiquidityETH'));
});

test('source lock rejects changed source and accepts the pinned tree', () => {
  const root = 'vendor/uniswap-v2';
  const lock = JSON.parse(readFileSync(`${root}/source-lock.json`, 'utf8'));
  assert.doesNotThrow(() => verifyUniswapSources(root, lock));
  const temporary = mkdtempSync(join(tmpdir(), 'uniswap-source-test-'));
  try {
    mkdirSync(join(temporary, 'core'));
    writeFileSync(join(temporary, 'core', 'changed.sol'), 'changed');
    assert.throws(() => verifyUniswapSources(temporary, lock), /source .*mismatch|source .*missing/i);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
