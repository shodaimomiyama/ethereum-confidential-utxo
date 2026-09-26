const { chromium } = require('/tmp/ecu-ux02-assets/playwright/node_modules/playwright-core');
const fs = require('node:fs');
const crypto = require('node:crypto');

(async () => {
  const extensionPath = '/tmp/ecu-ux02-assets/metamask-chrome';
  const context = await chromium.launchPersistentContext('/tmp/ecu-ux02-assets/chromium-profile', {
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const workers = context.serviceWorkers().map((worker) => worker.url());
    const pages = context.pages().map((page) => page.url());
    const onboarding = context.pages().find((page) => page.url().includes('onboarding'));
    const advance = process.env.UX02_ADVANCE;
    if (onboarding && ['create', 'srp', 'password', 'finish'].includes(advance)) {
      await onboarding.getByText('新規ウォレットを作成').last().click();
      await onboarding.waitForTimeout(1000);
    }
    if (onboarding && ['srp', 'password', 'finish'].includes(advance)) {
      await onboarding.getByText('シークレットリカバリーフレーズを使用する').last().click();
      await onboarding.waitForTimeout(1000);
    }
    if (onboarding && ['password', 'finish'].includes(advance)) {
      const passwordPath = '/tmp/ecu-ux02-assets/password';
      if (!fs.existsSync(passwordPath)) fs.writeFileSync(passwordPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
      const password = fs.readFileSync(passwordPath, 'utf8');
      await onboarding.locator('#create-password-new').fill(password);
      await onboarding.locator('#create-password-confirm').fill(password);
      await onboarding.locator('#create-password-terms').check();
      await onboarding.getByRole('button', { name: 'パスワードを作成' }).click();
      await onboarding.waitForTimeout(1000);
    }
    let secretWords = [];
    if (onboarding && advance === 'finish') {
      await onboarding.getByRole('button', { name: '後で' }).click();
      await onboarding.waitForTimeout(1000);
      await onboarding.getByText('タップして確認').click();
      const recoveryText = await onboarding.locator('body').innerText();
      for (let i = 1; i <= 12; i++) {
        const match = recoveryText.match(new RegExp(`(?:^|\\n)${i}\\.\\n\\n([a-z]+)(?:\\n|$)`));
        if (!match) throw new Error(`Recovery word ${i} was not found`);
        secretWords.push(match[1]);
      }
      fs.writeFileSync('/tmp/ecu-ux02-assets/mnemonic', secretWords.join(' '), { mode: 0o600 });
      await onboarding.getByRole('button', { name: '続行' }).click();
      await onboarding.waitForTimeout(1000);
    }
    if (onboarding && ['unlock', 'resume', 'complete'].includes(advance)) {
      await onboarding.locator('#password').fill(fs.readFileSync('/tmp/ecu-ux02-assets/password', 'utf8'));
      await onboarding.locator('button[type="submit"]').click();
      await onboarding.waitForTimeout(1000);
    }
    if (onboarding && ['resume', 'complete'].includes(advance)) {
      await onboarding.getByRole('button', { name: '後で' }).click();
      await onboarding.waitForTimeout(1000);
      await onboarding.getByText('タップして確認').click();
      const recoveryText = await onboarding.locator('body').innerText();
      for (let i = 1; i <= 12; i++) {
        const match = recoveryText.match(new RegExp(`(?:^|\\n)${i}\\.\\n\\n([a-z]+)(?:\\n|$)`));
        if (!match) throw new Error(`Recovery word ${i} was not found`);
        secretWords.push(match[1]);
      }
      fs.writeFileSync('/tmp/ecu-ux02-assets/mnemonic', secretWords.join(' '), { mode: 0o600 });
      await onboarding.getByRole('button', { name: '続行' }).click();
      await onboarding.waitForTimeout(1000);
    }
    if (onboarding && advance === 'complete') {
      const knownPositions = [];
      for (let i = 0; i < await onboarding.locator('input[type="password"]').count(); i++) {
        const parentText = await onboarding.locator('input[type="password"]').nth(i).locator('..').innerText();
        const position = Number(parentText.match(/\b(1[0-2]|[1-9])\./)?.[1]);
        knownPositions.push(position);
      }
      const missing = Array.from({ length: 12 }, (_, i) => i).filter((i) => !knownPositions.includes(i + 1));
      process.stdout.write(JSON.stringify({ knownPositions, missingIndices: missing }) + '\n');
      if (knownPositions.length !== 9 || knownPositions.some((x) => !x) || missing.length !== 3) throw new Error('Unexpected confirmation input arrangement');
      for (const i of missing) {
        try {
          await onboarding.getByText(secretWords[i], { exact: true }).last().click();
        } catch {
          throw new Error(`Confirmation option for position ${i + 1} was not selectable`);
        }
      }
      await onboarding.waitForTimeout(500);
      await onboarding.getByRole('button', { name: '了解' }).click();
      await onboarding.waitForTimeout(1000);
    }
    if (onboarding && advance === 'metrics') {
      await onboarding.locator('#metametrics-opt-in').uncheck();
      await onboarding.locator('#metametrics-datacollection-opt-in').uncheck();
      await onboarding.getByRole('button', { name: '続行' }).click();
      await onboarding.waitForTimeout(1000);
    }
    let text = onboarding && /#\/onboarding\/(welcome|create-password|setup-passkey|metametrics)(?:$|\?)/.test(onboarding.url()) ? await onboarding.locator('body').innerText() : null;
    if (text && secretWords.length) {
      for (const word of secretWords) text = text.replaceAll(new RegExp(`\\b${word}\\b`, 'g'), '[redacted]');
    }
    const inputs = [];
    if (onboarding) {
      for (let i = 0; i < await onboarding.locator('input').count(); i++) {
        const input = onboarding.locator('input').nth(i);
        inputs.push({ type: await input.getAttribute('type'), placeholder: await input.getAttribute('placeholder'), id: await input.getAttribute('id'), name: await input.getAttribute('name') });
      }
    }
    process.stdout.write(JSON.stringify({ workers, pages, url: onboarding?.url(), text, inputs, capturedTestMnemonic: secretWords.length === 12 }, null, 2) + '\n');
  } finally {
    await context.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
