// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {DemoUSD} from "../../../src/integration/uniswap/DemoUSD.sol";

contract DemoUSDSpender {
    function spend(DemoUSD token, address owner, address recipient, uint256 amount) external returns (bool) {
        return token.transferFrom(owner, recipient, amount);
    }
}

contract DemoUSDTest {
    function test_initialSupplyAndMetadata() public {
        DemoUSD token = new DemoUSD(address(this));
        require(keccak256(bytes(token.name())) == keccak256(bytes("Demo USD")), "name");
        require(keccak256(bytes(token.symbol())) == keccak256(bytes("dUSD")), "symbol");
        require(token.decimals() == 18, "decimals");
        require(token.totalSupply() == 1_000_000e18, "supply");
        require(token.balanceOf(address(this)) == 1_000_000e18, "initial holder");
    }

    function test_transferAndApprovalMoveExactAmountWithoutChangingSupply() public {
        DemoUSD token = new DemoUSD(address(this));
        DemoUSDSpender spender = new DemoUSDSpender();
        address recipient = address(0xBEEF);
        require(token.transfer(recipient, 25e18), "transfer");
        require(token.approve(address(spender), 10e18), "approve");
        require(spender.spend(token, address(this), recipient, 10e18), "transferFrom");
        require(token.balanceOf(recipient) == 35e18, "recipient balance");
        require(token.balanceOf(address(this)) == 999_965e18, "holder balance");
        require(token.allowance(address(this), address(spender)) == 0, "allowance");
        require(token.totalSupply() == 1_000_000e18, "supply changed");
    }

    function test_zeroInitialHolderReverts() public {
        try new DemoUSD(address(0)) {
            revert("zero holder accepted");
        } catch {}
    }

    function test_zeroRecipientAndInsufficientBalanceRevert() public {
        DemoUSD token = new DemoUSD(address(this));
        try token.transfer(address(0), 1) {
            revert("zero recipient accepted");
        } catch {}
        try token.transfer(address(0xBEEF), 1_000_001e18) {
            revert("overspend accepted");
        } catch {}
    }
}
