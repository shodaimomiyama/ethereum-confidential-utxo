import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { generateMnemonic, mnemonicToAccount, english } from 'viem/accounts';
import { expect, it } from 'vitest';
import { createKeySession, recipientMessage } from '../../../apps/uniswap-web/src/live/key-session.js';
import { startBrowserLiveEnvironment } from './browser-live-environment.js';

const extensionPath = process.env.ECU_METAMASK_EXTENSION_PATH
  ?? '/tmp/ecu-ux02-assets/metamask-chrome';

function chromeForTesting(): string {
  if (process.env.ECU_CHROME_FOR_TESTING) return process.env.ECU_CHROME_FOR_TESTING;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const candidates = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) =>
    Number(b.slice(9)) - Number(a.slice(9)));
  for (const name of candidates) {
    const executable = join(cache, name,
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (existsSync(executable)) return executable;
  }
  throw new Error('CHROME_FOR_TESTING_UNAVAILABLE');
}

async function importThrowawayWallet(context: BrowserContext, mnemonic: string): Promise<{ page: Page; password: string }> {
  const onboarding = context.pages().find(page => page.url().includes('/onboarding/'))
    ?? await context.waitForEvent('page', { timeout: 20_000 });
  await onboarding.locator('select').selectOption('en');
  await onboarding.getByText('I have an existing wallet').last().click();
  await onboarding.getByText('Import using Secret Recovery Phrase').last().click();
  for (const word of mnemonic.split(' ')) {
    const input = onboarding.locator('form textarea, form input').last();
    await input.fill(word);
    await input.press('Space');
  }
  await onboarding.locator('form input').last().press('Backspace');
  await onboarding.getByRole('button', { name: 'Continue' }).click();
  const password = randomBytes(24).toString('hex');
  await onboarding.locator('#create-password-new').fill(password);
  await onboarding.locator('#create-password-confirm').fill(password);
  await onboarding.locator('#create-password-terms').check();
  await onboarding.getByRole('button', { name: 'Create password' }).click();
  await onboarding.getByRole('button', { name: 'Maybe later' }).click();
  await onboarding.locator('#metametrics-opt-in').uncheck();
  await onboarding.locator('#metametrics-datacollection-opt-in').uncheck();
  await onboarding.getByRole('button', { name: 'Continue' }).click();
  await onboarding.getByRole('button', { name: 'Open wallet' }).click();
  await onboarding.goto(`${onboarding.url().split('#')[0]}#/`);
  if (onboarding.url().includes('#/unlock')) {
    await onboarding.locator('#password').fill(password);
    await onboarding.locator('button[type="submit"]').click();
  }
  if (await onboarding.getByText('Unlock', { exact: true }).count()) throw new Error('METAMASK_WALLET_LOCKED');
  return { page: onboarding, password };
}

async function setPublicBalance(rpcUrl: string, owner: string): Promise<void> {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance',
      params: [owner, '0x8ac7230489e80000'] }) });
  const body = await response.json() as { error?: unknown };
  if (!response.ok || body.error) throw new Error('TEST_ACCOUNT_FUNDING_FAILED');
}

async function mineBlock(rpcUrl: string): Promise<void> {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'evm_mine', params: [] }) });
  const body = await response.json() as { error?: unknown };
  if (!response.ok || body.error) throw new Error('LOCAL_BLOCK_MINING_FAILED');
}

async function appStorage(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const serialize = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
      item instanceof ArrayBuffer ? hex(new Uint8Array(item))
        : ArrayBuffer.isView(item) ? hex(new Uint8Array(item.buffer, item.byteOffset, item.byteLength)) : item) ?? '';
    const stored: unknown[] = [Object.fromEntries(Object.entries(localStorage)),
      Object.fromEntries(Object.entries(sessionStorage))];
    for (const entry of await indexedDB.databases()) {
      if (!entry.name) continue;
      const databaseName = entry.name;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        for (const name of db.objectStoreNames) {
          const values = await new Promise<unknown[]>((resolve, reject) => {
            const transaction = db.transaction(name, 'readonly');
            const request = transaction.objectStore(name).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          stored.push({ database: databaseName, store: name, values });
        }
      } finally { db.close(); }
    }
    return serialize(stored);
  });
}

function assertNoSecret(text: string, secrets: readonly string[], surface: string): void {
  const lowered = text.toLowerCase();
  for (const secret of secrets) {
    if (lowered.includes(secret.toLowerCase())) throw new Error(`SECRET_EXPOSED_IN_${surface}`);
  }
}

it('receives a real demo reward through the public UI and MetaMask', async () => {
  const manifestPath = join(extensionPath, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('METAMASK_EXTENSION_UNAVAILABLE');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string; version_name?: string };
  if (manifest.version !== '13.50.0.0' || manifest.version_name !== '13.50.0') {
    throw new Error('METAMASK_EXTENSION_VERSION_MISMATCH');
  }
  const environment = await startBrowserLiveEnvironment();
  let profile: string | undefined;
  let context: BrowserContext | undefined;
  try {
    profile = mkdtempSync(join(tmpdir(), 'ecu-live-metamask-'));
    const mnemonic = generateMnemonic(english);
    const account = mnemonicToAccount(mnemonic);
    const owner = account.address;
    const pool = (environment.coreManifest as { pool: { address: `0x${string}` } }).pool.address;
    const derivedSignature = await account.signMessage({
      message: { raw: recipientMessage(31337n, pool as Parameters<typeof recipientMessage>[1],
        owner as Parameters<typeof recipientMessage>[2]) },
    });
    const fixtureKeySession = createKeySession({ subscribe: () => () => {} },
      { scope: { deploymentId: environment.deploymentId, owner } as Parameters<typeof createKeySession>[1]['scope'], epoch: 1 },
      { chainId: 31337n, pool });
    let receiptPrivateKey: string;
    try {
      await fixtureKeySession.prepare(derivedSignature);
      receiptPrivateKey = Buffer.from(fixtureKeySession.recipientPrivateKeyForWorker()).toString('hex');
    } finally { fixtureKeySession.dispose(); }
    const secrets = [mnemonic, Buffer.from(account.getHdKey().privateKey!).toString('hex'), derivedSignature,
      receiptPrivateKey].flatMap(value => value.startsWith('0x') ? [value, value.slice(2)] : [value]);
    await setPublicBalance(environment.rpcUrl, owner);
    context = await chromium.launchPersistentContext(profile, { headless: false,
      executablePath: chromeForTesting(), ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
        '--ignore-certificate-errors', '--no-first-run'] });
    const wallet = await importThrowawayWallet(context, mnemonic);
    const app = await context.newPage();
    const outboundBodies: string[] = [];
    const browserMessages: string[] = [];
    const rewardSubmissions: string[] = [];
    app.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== environment.origin) return;
      if (url.pathname === '/rpc' || url.pathname.startsWith('/v1/')) {
        outboundBodies.push(request.postData() ?? '');
      }
      if (url.pathname === '/v1/rewards' && request.method() === 'POST') {
        rewardSubmissions.push(request.url());
      }
    });
    app.on('console', message => browserMessages.push(message.text()));
    app.on('pageerror', error => browserMessages.push(error.message));
    await app.goto(environment.appUrl);
    if (await app.getByText('Dim app is not configured').count()) throw new Error('LIVE_STARTUP_FAILED');
    await app.getByRole('heading', { name: 'Try Dim' }).waitFor({ timeout: 30_000 });
    await app.getByRole('button', { name: 'Connect wallet' }).click();
    await app.waitForTimeout(2500);
    if (wallet.page.url().includes('#/unlock')) {
      await wallet.page.locator('#password').fill(wallet.password);
      await wallet.page.locator('button[type="submit"]').click();
      await wallet.page.waitForTimeout(1500);
      await app.getByRole('button', { name: 'Connect wallet' }).click();
      await app.waitForTimeout(1500);
    }
    const extensionId = new URL(wallet.page.url()).host;
    const notification = await context.newPage();
    await notification.goto(`chrome-extension://${extensionId}/notification.html`);
    await notification.getByRole('button', { name: 'Connect', exact: true }).click();
    await notification.close();
    await app.getByRole('button', { name: 'Switch network' }).waitFor({ timeout: 10_000 });
    await app.getByText(owner.toLowerCase(), { exact: true }).waitFor();
    await app.evaluate(rpcUrl => {
      const provider = (window as Window & { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
      if (!provider) throw new Error('METAMASK_PROVIDER_MISSING');
      void provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x7a69',
        chainName: 'Anvil local test', rpcUrls: [rpcUrl],
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }] });
    }, environment.browserRpcUrl);
    await app.waitForTimeout(1500);
    const networkNotification = await context.newPage();
    await networkNotification.goto(`chrome-extension://${extensionId}/notification.html`);
    await networkNotification.getByRole('button', { name: 'Confirm', exact: true }).click({ timeout: 15_000 });
    await networkNotification.close();
    await app.waitForTimeout(1200);
    if (await app.getByRole('button', { name: 'Switch network' }).count()) {
      await app.getByRole('button', { name: 'Switch network' }).click();
      const switchNotification = await context.newPage();
      await switchNotification.goto(`chrome-extension://${extensionId}/notification.html`);
      await switchNotification.getByRole('button', { name: 'Confirm', exact: true }).click({ timeout: 15_000 });
      await switchNotification.close();
    }
    await app.getByRole('button', { name: 'Prepare privacy key' }).waitFor({ timeout: 15_000 });
    await app.getByRole('button', { name: 'Prepare privacy key' }).click();
    const keyNotification = await context.newPage();
    await keyNotification.goto(`chrome-extension://${extensionId}/notification.html`);
    await keyNotification.getByRole('button', { name: 'Confirm', exact: true }).click({ timeout: 15_000 });
    await keyNotification.close();
    await app.getByRole('button', { name: 'Connect service' }).waitFor({ timeout: 15_000 });
    await app.getByRole('button', { name: 'Connect service' }).click();
    const authNotification = await context.newPage();
    await authNotification.goto(`chrome-extension://${extensionId}/notification.html`);
    await authNotification.getByRole('button', { name: 'Confirm', exact: true }).click({ timeout: 15_000 });
    await authNotification.close();
    await app.getByRole('button', { name: 'Recheck public balance' }).waitFor({ timeout: 15_000 });
    await app.getByRole('button', { name: 'Recheck public balance' }).click();
    await app.getByText('Ready to use', { exact: true }).waitFor({ timeout: 30_000 });
    await app.getByLabel('Demo reward amount in ETH').fill('0.002');
    await app.getByRole('button', { name: 'Request demo reward' }).click({ timeout: 15_000 });
    const rewardNotification = await context.newPage();
    await rewardNotification.goto(`chrome-extension://${extensionId}/notification.html`);
    await rewardNotification.getByRole('button', { name: 'Confirm', exact: true }).click({ timeout: 15_000 });
    await rewardNotification.close();
    await app.getByRole('button', { name: 'Recheck reward request' }).waitFor({ timeout: 30_000 });
    for (let attempt = 0; attempt < 35; attempt++) {
      if (await app.getByText('Distribution finalized; receipt pending', { exact: true }).count()) break;
      await app.getByRole('button', { name: 'Recheck reward request' }).click();
      if (attempt % 10 === 9) await mineBlock(environment.rpcUrl);
      await app.waitForTimeout(2_000);
    }
    if (await app.getByText('Distribution finalized; receipt pending', { exact: true }).count() === 0) {
      const status = await app.getByRole('heading', { name: 'Demo reward request' })
        .first().locator('..').locator('p').first().innerText();
      const detail = await app.evaluate(async ({ deploymentId, owner }) => {
        const url = new URL('/v1/rewards', location.origin);
        url.searchParams.set('deploymentId', deploymentId);
        url.searchParams.set('owner', owner);
        const response = await fetch(url, { credentials: 'same-origin' });
        const data = await response.json() as { rewards?: { status?: string; availability?: string;
          attemptIds?: unknown[]; txHashes?: string[] }[] };
        return { httpStatus: response.status, status: data.rewards?.[0]?.status,
          availability: data.rewards?.[0]?.availability,
          attempts: data.rewards?.[0]?.attemptIds?.length,
          txCount: data.rewards?.[0]?.txHashes?.length,
          txHash: data.rewards?.[0]?.txHashes?.at(-1) };
      }, { deploymentId: environment.deploymentId, owner });
      let txReceipt: unknown;
      if (detail.txHash) {
        const response = await fetch(environment.rpcUrl, { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_getTransactionReceipt', params: [detail.txHash] }) });
        const data = await response.json() as { result?: { status?: string; blockNumber?: string } };
        txReceipt = data.result && { status: data.result.status, mined: !!data.result.blockNumber };
      }
      throw new Error(`REWARD_RECEIPT_NOT_AVAILABLE ${status.slice(0, 80)} ${JSON.stringify({ ...detail, txHash: undefined, txReceipt })}`);
    }
    await app.getByRole('button', { name: 'Recheck status' }).last().click();
    await app.getByRole('button', { name: 'Check private receipt' }).waitFor({ timeout: 15_000 });
    await app.getByRole('button', { name: 'Check private receipt' }).click();
    await app.getByText('Reward received', { exact: true }).waitFor({ timeout: 15_000 });
    await app.getByRole('button', { name: 'Resync private balance' }).click();
    await app.waitForFunction(() => {
      const value = document.querySelector('.balances .surface:nth-child(2) strong')?.textContent;
      return value !== undefined && value !== null && !value.startsWith('0 ETH');
    }, undefined, { timeout: 30_000 });
    const privateBalance = await app.locator('.balances .surface:nth-child(2) strong').innerText();
    expect(privateBalance).toBe('0.002 ETH');
    expect(rewardSubmissions).toHaveLength(1);
    assertNoSecret(await app.content(), secrets, 'UI');
    assertNoSecret(app.url(), secrets, 'URL');
    assertNoSecret(await appStorage(app), secrets, 'STORAGE');
    assertNoSecret(outboundBodies.join('\n'), secrets, 'API_OR_RPC_REQUEST');
    assertNoSecret(browserMessages.join('\n'), secrets, 'CONSOLE_OR_ERROR');

    // A fresh page needs an explicit wallet and key preparation before private balance recovery.
    // It must neither prompt for signatures nor replay the completed reward on its own.
    await app.reload();
    await app.getByRole('heading', { name: 'Try Dim' }).waitFor({ timeout: 30_000 });
    await app.waitForTimeout(2_000);
    await app.getByRole('button', { name: 'Connect wallet' }).waitFor();
    expect(await app.locator('.balances .surface:nth-child(2) strong').innerText()).toBe('0 ETH');
    expect(rewardSubmissions).toHaveLength(1);
    expect(context.pages().filter(page => page.url().includes('/notification.html'))).toHaveLength(0);
    assertNoSecret(await app.content(), secrets, 'RELOADED_UI');
    assertNoSecret(app.url(), secrets, 'RELOADED_URL');
    assertNoSecret(await appStorage(app), secrets, 'RELOADED_STORAGE');
    assertNoSecret(outboundBodies.join('\n'), secrets, 'API_OR_RPC_REQUEST');
    assertNoSecret(browserMessages.join('\n'), secrets, 'CONSOLE_OR_ERROR');
  } finally {
    try { await context?.close(); }
    finally {
      try { if (profile) rmSync(profile, { recursive: true, force: true }); }
      finally { await environment.close(); }
    }
  }
}, 300_000);
