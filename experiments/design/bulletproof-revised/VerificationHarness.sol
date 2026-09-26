pragma solidity ^0.4.19;

contract VerificationHarness {
    address public verifier;

    function VerificationHarness(address target) public {
        verifier = target;
    }

    function() external {
        address target = verifier;
        assembly {
            let buffer := mload(0x40)
            calldatacopy(buffer, 0, calldatasize)
            let succeeded := staticcall(gas, target, buffer, calldatasize, buffer, 0x20)
            if iszero(and(succeeded, eq(returndatasize, 0x20))) { revert(0, 0) }
            if iszero(eq(mload(buffer), 1)) { revert(0, 0) }
            return(buffer, 0x20)
        }
    }
}
