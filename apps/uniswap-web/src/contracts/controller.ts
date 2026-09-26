import type { OperationId, RequestId, Scope } from '@confidential-utxo/uniswap';
import type { Card, ReasonCode, ViewState } from './state.js';

export type UiAction =
  | { readonly type: 'edit'; readonly card: Card; readonly field: string; readonly value: string }
  | { readonly type: 'start'; readonly card: Card }
  | { readonly type: 'confirm-terms'; readonly card: 'pay' }
  | { readonly type: 'recheck'; readonly operationId: OperationId }
  | { readonly type: 'recheck-reward'; readonly requestId: RequestId }
  | { readonly type: 'resync' }
  | { readonly type: 'resume-original'; readonly operationId: OperationId }
  | { readonly type: 'retry-attempt'; readonly operationId: OperationId }
  | { readonly type: 'acknowledge-receipt'; readonly operationId: OperationId }
  | { readonly type: 'switch-scope'; readonly scope: Scope };

export type DispatchResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'blocked'; readonly reason: ReasonCode };

export interface UiController {
  snapshot(): ViewState;
  subscribe(listener: (state: ViewState) => void): () => void;
  dispatch(action: UiAction): Promise<DispatchResult>;
  dispose(): void;
}

export function actionKey(action: UiAction): string {
  return action.type === 'edit' || action.type === 'start'
    ? `${action.type}:${action.card}`
    : action.type;
}

export function isActionAllowed(
  state: Pick<ViewState, 'allowedActions'>,
  action: UiAction,
): boolean {
  return state.allowedActions.includes(actionKey(action));
}
