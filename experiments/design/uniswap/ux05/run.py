#!/usr/bin/env python3
"""Enumerate the specified public-history arithmetic and a reward-affordability oracle."""

import hashlib
import json
import platform
from pathlib import Path


HERE = Path(__file__).resolve().parent
PLAN = HERE / "plan.json"


def main() -> None:
    plan = json.loads(PLAN.read_text())
    inputs = plan["input"]
    deposit = inputs["depositUnits"]
    payment = inputs["paymentUnits"]
    actual = inputs["actualRewardUnits"]
    alternative = inputs["alternativeRewardUnits"]
    probe = inputs["activeProbeUnits"]

    # Each anonymous output is positive, and the payer's remainder is positive.
    passive = [x for x in range(1, deposit) if deposit - x > 0 and x - payment > 0]
    sender = [x for x in passive if x == actual]
    recipient = list(passive)  # q and recipient are already public for this history.
    after_withdrawal = [x for x in passive if x - payment == actual - payment]
    probe_affordable = [x for x in passive if deposit - x >= probe]
    probe_insufficient = [x for x in passive if deposit - x < probe]

    assert actual in passive and alternative in passive
    assert sender == [actual]
    assert recipient == passive
    assert after_withdrawal == [actual]
    assert actual in probe_affordable and alternative in probe_insufficient

    result = {
        "id": plan["id"],
        "planSha256": hashlib.sha256(PLAN.read_bytes()).hexdigest(),
        "runtime": {"python": platform.python_version(), "implementation": platform.python_implementation()},
        "inputs": inputs,
        "unitWei": inputs["uWei"],
        "equations": ["reward + senderChange = 10u", "reward = 3u + payerRemainder"],
        "candidatesInWholeUnits": {
            "passivePublicAfterPayment": passive,
            "senderKnowsActualReward": sender,
            "recipientKnowsOnlyPublicSwapOutput": recipient,
            "publicAfterLaterFullWithdrawalOfActualRemainder": after_withdrawal,
            "active4uProbeAffordable": probe_affordable,
            "active4uProbeInsufficient": probe_insufficient,
        },
        "actualHistory": {"rewardUnits": actual, "changeUnits": deposit - actual, "remainderUnits": actual - payment},
        "counterfactualHistory": {"rewardUnits": alternative, "changeUnits": deposit - alternative, "remainderUnits": alternative - payment},
        "observationSeparation": {
            "publicPaymentWei": str(payment * int(inputs["uWei"])),
            "activeProbeIsAPrivateResponseToARequester": True,
            "successWouldCreateAnAdditionalDistributionAndChangeTheHistory": True,
            "one4uProbeDistinguishesActualFromCounterfactual": True,
        },
        "actualEvidence": {
            "arithmeticConsistency": True,
            "liveCryptography": False,
            "realUniswap": False,
            "deployedApiAndLogs": False,
            "realGasAndCalldata": False,
            "finalizedChainHistory": False,
        },
        "decision": "partial: arithmetic and active-oracle effects reproduced; UPRIV-02 adoption question remains unresolved until real public metadata, crypto, API/logs and chain history are inspected",
    }
    (HERE / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
