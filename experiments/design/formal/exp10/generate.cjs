const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const load = createRequire(path.resolve(__dirname, '../../bulletproof/package.json'));
const { Interface, keccak256 } = load('ethers');
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json')));
const runtime = fs.readFileSync(path.join(__dirname, plan.target.sourceRuntime), 'utf8').trim();
assert.equal(keccak256(`0x${runtime}`), plan.target.keccak256);
const iface = new Interface(['function verify(bytes32,uint256,uint256[10],uint256[5],uint256[],uint256[]) view returns (bool)']);
const calldata = iface.encodeFunctionData('verify', [
  `0x${'00'.repeat(32)}`, 0n, Array(10).fill(0n), Array(5).fill(0n), [], Array(12).fill(0n)
]);
const code = `requires "evm.md"\n\nmodule EXP10-SPEC\n    imports EVM\n\n    claim [wrong-left-length]:\n        <k> #execute => #halt ... </k>\n        <mode> NORMAL </mode>\n        <schedule> BYZANTIUM </schedule>\n        <useGas> false </useGas>\n        <callStack> .List </callStack>\n        <memoryUsed> 0 </memoryUsed>\n        <localMem> .Bytes </localMem>\n        <wordStack> .WordStack </wordStack>\n        <program> #parseByteStack("0x${runtime}") </program>\n        <jumpDests> #computeValidJumpDests(#parseByteStack("0x${runtime}")) </jumpDests>\n        <callData> #parseByteStack("${calldata}") </callData>\n        <pc> 0 => _ </pc>\n        <statusCode> _ => EVMC_REVERT </statusCode>\nendmodule\n`;
fs.writeFileSync(path.join(__dirname, 'direct-spec.k'), code, { flag: 'wx' });
fs.writeFileSync(path.join(__dirname, 'input.json'), JSON.stringify({ runtimeKeccak256: plan.target.keccak256, calldata,
  calldataBytes: (calldata.length - 2) / 2, symbolicWords: 0, leftLength: 0, rightLength: 12 }, null, 2) + '\n', { flag: 'wx' });
