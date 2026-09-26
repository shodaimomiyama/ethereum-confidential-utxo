import type { CardState, ValidationReason } from '../../contracts/state.js';

const recovery: Partial<Record<ValidationReason, string>> = {
  INVALID_DECIMAL: 'Enter a positive decimal amount in ETH, with up to 18 decimal places.',
  NO_SINGLE_INPUT: 'No single available private UTXO covers this amount and leaves positive change. Choose a smaller amount or receive another UTXO.',
  QUOTE_STALE: 'The quote is stale. Edit the payment to request fresh terms before starting.',
  SERVICE_UNAVAILABLE: 'The service is unavailable. Keep this operation ID and try rechecking later.',
  RECEIPT_INVALID: 'The private receipt could not be verified. Recheck or resync before treating funds as available.',
  UNSUPPORTED_RECIPIENT: 'Enter a supported recipient address, or use your own address for this demo.',
  INSUFFICIENT_FUNDS: 'The public balance is too low for this amount and gas.',
  GAS_REQUIRED: 'Get test ETH for gas and recheck the public balance.',
  PREPARATION_MISSING: 'Connect a wallet and complete setup before starting.',
  WRONG_NETWORK: 'Switch to Ethereum Sepolia before starting.',
  KEY_REQUIRED: 'Prepare your private receipt key before starting.',
  TERMS_CHANGED: 'The payment terms changed. Compare the previous and new terms before confirming.',
  AUTHORIZATION_ACTIVE: 'Wait for the previous authorization to settle before confirming new terms.',
  TERMS_EXPIRED: 'Enter a deadline later than the latest chain timestamp, in integer Unix seconds.',
  MINIMUM_NOT_MET: 'Enter a positive minimum output amount in dUSD.',
  RESULT_UNKNOWN: 'The result is unknown. Recheck the existing operation before making another request.',
};

const phaseText: Record<CardState['phase'], string> = {
  'needs-preparation': 'Preparation needed',
  'invalid-input': 'Check input',
  ready: 'Ready for review',
  preparing: 'Preparing request',
  'confirm-terms': 'Review changed terms',
  'awaiting-approval': 'Waiting for wallet approval',
  submitting: 'Submitting transaction',
  pending: 'Submitted; waiting for confirmation',
  'confirmed-receipt-pending': 'On-chain success; private receipt pending',
  complete: 'Completed',
  failed: 'Attempt failed',
  unknown: 'Result unknown',
  'receipt-invalid': 'Private receipt invalid',
};

const approvalText: Record<NonNullable<CardState['approvalPurpose']>, string> = {
  'recipient-key': 'Approve preparing the private receipt key.',
  'api-login': 'Sign the demo service login request.',
  'recipient-info': 'Sign recipient information for this request.',
  'pool-authorization': 'Review the pool payment authorization in your wallet.',
  'payment-authorization': 'Review the payment authorization in your wallet.',
  transaction: 'Review the transaction in your wallet.',
};

export function CardFeedback({ card, blockedReason }: { readonly card: CardState; readonly blockedReason?: ValidationReason }) {
  const reason = card.reason ?? blockedReason;
  const message = reason ? recovery[reason] ?? `Action unavailable: ${reason}.` : undefined;
  return <div className="card-feedback" aria-live="polite">
    <p className="status-line">{phaseText[card.phase]}</p>
    {card.approvalPurpose && card.phase === 'awaiting-approval' && <p>{approvalText[card.approvalPurpose]}</p>}
    {message && <p role="alert">{message}</p>}
  </div>;
}
