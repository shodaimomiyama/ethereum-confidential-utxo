// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

contract EnvironmentSmoke {
    function answer() external pure returns (uint256) {
        return 42;
    }
}

contract EnvironmentSmokeTest {
    function test_answerIs42() public {
        require(new EnvironmentSmoke().answer() == 42, "wrong answer");
    }
}
