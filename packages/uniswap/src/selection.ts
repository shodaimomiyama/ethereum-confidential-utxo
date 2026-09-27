import type { Address, InputId } from './domain.js';

export interface PayInput {
  readonly id: InputId;
  readonly valueWei: bigint;
  readonly owner: Address;
  readonly state: 'available' | 'pending' | 'receipt-invalid' | 'unknown' | 'reserved';
}

export function selectPayInput(
  inputs: readonly PayInput[],
  paymentWei: bigint,
  owner: Address,
): PayInput | undefined {
  if (paymentWei <= 0n) return undefined;
  let selected: PayInput | undefined;
  for (const input of inputs) {
    if (input.owner.toLowerCase() !== owner.toLowerCase()
      || input.state !== 'available'
      || input.valueWei <= paymentWei) continue;
    if (selected === undefined
      || input.valueWei < selected.valueWei
      || (input.valueWei === selected.valueWei && BigInt(input.id) < BigInt(selected.id))) {
      selected = input;
    }
  }
  return selected;
}
