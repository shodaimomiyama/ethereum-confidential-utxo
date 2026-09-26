const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const useBaseline = createRequire(path.resolve(__dirname, '../../bulletproof/package.json'));
const { keccak256, toUtf8Bytes, toBeHex, concat } = useBaseline('ethers');

const root = __dirname;
const vectors = JSON.parse(fs.readFileSync(path.join(root, '../vectors.json')));
const baseline = JSON.parse(fs.readFileSync(path.join(root, '../../bulletproof-revised/profile.json')));
const points = vectors.generators;
const find = (role, index) => {
  const point = points.find(item => item.role === role && item.index === index);
  if (!point) throw Error(`Missing ${role}[${index}]`);
  return [BigInt(`0x${point.xHex}`).toString(), BigInt(`0x${point.yHex}`).toString()];
};
const base = [...find('valueBase', 0), ...find('blindingBase', 0)];
const vector = role => {
  const pairs = Array.from({ length: 64 }, (_, i) => find(role, i));
  return [...pairs.map(pair => pair[0]), ...pairs.map(pair => pair[1])];
};
const parameters = { base, gs: vector('vectorG'), hs: vector('vectorH') };
const tags = Object.fromEntries(Object.entries(baseline.tags).map(([name, label]) => [name, label.replaceAll('/v1', '/v2')]));
const word = value => toBeHex(BigInt(value), 32);
const ordered = [base.slice(0, 2), base.slice(2, 4),
  ...Array.from({ length: 64 }, (_, i) => [parameters.gs[i], parameters.gs[64 + i]]),
  ...Array.from({ length: 64 }, (_, i) => [parameters.hs[i], parameters.hs[64 + i]])];
const expectedParametersHash = keccak256(concat([keccak256(toUtf8Bytes(tags.parameters)), word(64), ...ordered.flat().map(word)]));
const profile = { ...baseline, experiment: 'EXP-07B', status: 'Design-stage v2 candidate; not security reviewed', tags,
  expectedParametersHash,
  parametersHash: 'K(tag(parameters)||64||valueBase||blindingBase||g[0]||...||g[63]||h[0]||...||h[63]); points selected by role and index from EXP-07A vectors.json, rather than by their JSON order',
  generatorDerivation: 'EXP-07A vectors.json, gnark-crypto v0.20.1 HashToG1',
  initialState: 'prefix=tag(protocol)||uint256(64)||uint256(1)||parametersHash||operationId||tag(role)||uint256(outputIndex)||C_range(x,y); state=K(prefix) is trace-only',
  challenge: 'segment=tag(stage)||uint256(payload byte length)||payload; inputState=K(prefix||segment); first c=uint256(K(inputState||tag(candidate)||uint256(counter))) with 0<c<q and counter in [0,255] is accepted; prefix=prefix||segment||tag(accepted)||uint256(c); no modular reduction',
  transcript: 'Full-prefix; each challenge hashes an explicitly encoded concatenation of all earlier stage data. The trace state is only K(prefix), never substituted for the prefix in challenge derivation.',
  parametersValidationPlacement: 'EXP-07A validates all fixed points and reproducible derivation; this experiment checks their canonical/on-curve/nonidentity/distinctness and constructor digest, but does not establish unknown discrete-log relations.' };
profile.stages = baseline.stages.map(item => item.stage === 'inner'
  ? { ...item, operation: 'prefix=prefix||tag(inner)||uint256(160)||uint256(64)||P||uPoint; no challenge here' }
  : item);
parameters.expectedParametersHash = expectedParametersHash;
fs.writeFileSync(path.join(root, 'parameters.json'), JSON.stringify(parameters, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'profile.json'), JSON.stringify(profile, null, 2) + '\n');
console.log(expectedParametersHash);
