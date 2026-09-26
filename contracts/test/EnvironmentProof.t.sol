// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {EnvironmentSmoke} from "./EnvironmentSmoke.t.sol";

contract EnvironmentProofTest {
    function test_provesAnswer() public {
        EnvironmentSmoke target = new EnvironmentSmoke();
        require(target.answer() == 42, "unexpected result");
    }
}
